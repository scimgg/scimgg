import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import type { EncounterModifierSelection, EncounterModifierTier } from '../core/encounters/encounterFactory';
import { consolidateRetiredEncounterKinds } from '../encounters/catalog';
import {
  DEFAULT_TOUCH_PREFS,
  setTouchPrefs,
  TOUCH_LONG_PRESS_MAX_MS,
  TOUCH_LONG_PRESS_MIN_MS,
  TOUCH_LONG_PRESS_STEP_MS,
  TOUCH_MENU_ROW_HEIGHT_MAX_PX,
  TOUCH_MENU_ROW_HEIGHT_MIN_PX,
  TOUCH_MENU_ROW_HEIGHT_STEP_PX,
} from '../input/touchPrefs';
import { isOsmInterfaceScaling, OSM_HOTKEY_SLOTS, OSM_INTERFACE_SCALING_DEFAULT } from '../layout/osmClientLayout';
import { isOsmHotkeySlot, JAGEX_BOSSING_HOTKEYS, OSM_HOTKEY_EMPTY, type OsmHotkeySlot } from '../layout/osmHotkeys';
import {
  type ClientLayoutMode,
  FIXED_SCALE_MAX,
  FIXED_SCALE_MIN,
  fixedFrameSizeAtScale,
  isClientLayoutMode,
  type Size,
} from '../layout/osrsClientLayout';
import { INNER_ZOOM_LEVEL_MAX, INNER_ZOOM_LEVEL_MIN } from '../render/projections/Projection3D';
import { ReplayUiPositionSchema, ReplayUiScaleSchema } from '../replay/format/presentationFormat';
import {
  type CompactOrbId,
  type CompactOrbsLayout,
  DEFAULT_COMPACT_ORBS_LAYOUT,
  DEFAULT_COMPACT_ORBS_ORDER,
  normalizeCompactOrbsLayout,
  normalizeCompactOrbsOrder,
} from '../types/compactOrbs';
import { DEFAULT_ENTITY_HIDER_OPTIONS, type EntityHiderOptions, parseEntityHiderOptions } from '../types/entityHider';
import {
  DEFAULT_PILLAR_ADDITIONS_OPTIONS,
  type PillarAdditionsOptions,
  parsePillarAdditionsOptions,
} from '../types/pillarAdditions';
import { BOOLEAN_MECHANICS_KEY_SET, type MechanicsConfig } from '../types/simulation';
import {
  clampTileGridWidth,
  DEFAULT_TILE_GRID_COLOR,
  DEFAULT_TILE_GRID_OPACITY,
  DEFAULT_TILE_GRID_WIDTH,
} from '../types/tileGrid';
import {
  DEFAULT_TZHAAR_HP_TRACKER_OPTIONS,
  parseTzhaarHpTrackerOptions,
  type TzhaarHpTrackerOptions,
} from '../types/tzhaarHpTracker';
import type { GpuStatus } from '../util/gpuDetection';
import { isAppleTouchDevice } from '../util/mobileDetection';
import { isStorageNamespaced, loadSetting, saveSetting } from '../util/storage';
import {
  TICK_CYCLE_MAX,
  TICK_CYCLE_MIN,
  TICK_FONT_SIZE_MAX,
  TICK_FONT_SIZE_MIN,
  TICK_OFFSET_LIMIT,
  type TickColorOverrides,
} from '../util/tickColor';
import { useIsMobileDevice } from './useIsMobileDevice';

const STORAGE_KEY = 'osrs-yama-settings';
/** The persisted settings blob's key, for the dev UI harness's saved-setup fixtures. */
export const PERSISTED_SETTINGS_KEY = STORAGE_KEY;

/**
 * What a saved `modifiersPerEncounter` entry means. Version 1: an entry is always the player's own
 * choice, and a kind without one plays its setup's default.
 */
export const MODIFIER_SETTINGS_VERSION = 1;

/**
 * Entries cleared once, on the way to version 1. Before it, Sol Heredit's default (Blasphemy III)
 * was saved like a choice whenever a selection was saved unchanged, so a saved Blasphemy III and the
 * same set picked on purpose cannot be told apart. Both are read as the default, which now follows
 * the Fortis Colosseum's start wave; a deliberate Blasphemy III saved since then is kept.
 */
const LEGACY_SAVED_DEFAULT_MODIFIERS: Readonly<Record<string, EncounterModifierSelection>> = {
  sol_heredit: { blasphemy: 3 },
};

/**
 * `settings` migrated from the stored `version` (absent: before versioning) to
 * {@link MODIFIER_SETTINGS_VERSION}. Idempotent: the result is at the current version, which a
 * second pass leaves alone. Every other entry and encounter is kept as saved.
 */
function migrateModifierSettings(settings: PersistedSettings, version: unknown): PersistedSettings {
  if (typeof version === 'number' && version >= MODIFIER_SETTINGS_VERSION) return settings;
  const modifiersPerEncounter = { ...settings.modifiersPerEncounter };
  for (const [kind, legacy] of Object.entries(LEGACY_SAVED_DEFAULT_MODIFIERS)) {
    const saved = modifiersPerEncounter[kind];
    if (saved !== undefined && sameModifierSelection(saved, legacy)) delete modifiersPerEncounter[kind];
  }
  return { ...settings, modifiersPerEncounter, modifierSettingsVersion: MODIFIER_SETTINGS_VERSION };
}

function sameModifierSelection(left: EncounterModifierSelection, right: EncounterModifierSelection): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/**
 * The context's anti-aliasing. An explicit On or Off always wins; Auto, the default, turns it off
 * without hardware acceleration and on iPhone and iPad (including iPadOS posing as a Mac), where
 * the multisampled framebuffer is memory the WebContent process cannot spare.
 */
export function resolveAntialias(
  preference: PersistedSettings['antiAliasing'],
  gpuStatus: GpuStatus,
  nav: Navigator = navigator,
): boolean {
  if (preference !== 'auto') return preference === 'on';
  return gpuStatus !== 'software' && !isAppleTouchDevice(nav);
}

/**
 * Same-origin channel used to live-sync settings between the main
 * window and any open popout windows. Scoped to a unique key so we
 * don't collide with other channels on the same origin.
 */
const SETTINGS_BROADCAST_CHANNEL = 'scimgg-settings:v1';

/** The three the speed control offers; anything else is a value no UI can show. */
const SPEED_MULTIPLIERS = [0.5, 1, 2] as const;

export interface UIPosition {
  x: number;
  y: number;
  anchorX: 'left' | 'right';
  anchorY: 'top' | 'bottom';
}

/**
 * Where the infobox strip is pinned:
 * - 'hud'       → "Chatbox": locked above the chatbox at the bottom left, in balanced rows as
 *                 wide as the chatbox, wrapping upward (layout/topChromeLayout.ts). The token is the
 *                 stored and recorded value from when the strip sat above the HUD; it is kept so
 *                 saved settings and recordings still mean that corner without a format change.
 * - 'inventory' → locked above the inventory/game panel (OSRS-style), left-aligned
 * - 'free'      → free-floating draggable panel using the persisted `infoboxPosition`
 */
export type InfoboxPinTarget = 'hud' | 'inventory' | 'free';

/**
 * Why `target` cannot be honored under `layout`, phrased for the user, or null when it can.
 *
 * Settings grays the segment out with this sentence and {@link resolveInfoboxPinTarget}
 * decides what renders, so both read the rule from here; expressing the condition a second
 * time at either call site is what lets the grayed option and the live one disagree.
 */
export function infoboxPinTargetUnavailableReason(target: InfoboxPinTarget, layout: ClientLayoutMode): string | null {
  if (target === 'inventory' && layout === 'fixed') {
    return 'Inventory is not available in Fixed.';
  }
  // The mobile side panel closes when its tab is tapped again, so there is not always a
  // panel to pin above.
  if (target === 'inventory' && layout === 'mobile') {
    return 'Inventory is not available in Mobile.';
  }
  return null;
}

/**
 * The pin target actually applied, falling back to the Chatbox corner every layout can host. The
 * stored preference is deliberately not rewritten: coercing it would spend the user's choice
 * the moment they looked at Fixed, instead of returning it when they leave.
 */
export function resolveInfoboxPinTarget(target: InfoboxPinTarget, layout: ClientLayoutMode): InfoboxPinTarget {
  return infoboxPinTargetUnavailableReason(target, layout) ? 'hud' : target;
}

export type GameResolutionMode = 'fit' | 'fixed';

/**
 * Identifies which option is selected in the Viewport preset dropdown.
 * This is the source of truth for the dropdown UI, independent of the
 * current width/height — so picking 'Custom' sticks even when the
 * custom values happen to match another preset's dimensions.
 */
export type ResolutionPresetId = 'fit' | 'osrs-fixed' | 'hd-720' | 'hd-1080' | 'custom';

/**
 * Fixed-resolution / letterbox settings for the game viewport.
 *
 * - mode 'fit':   viewport fills the available grid-panel space (default)
 * - mode 'fixed': viewport is locked to width × height and centered;
 *                 the letterbox stage clips via `overflow: hidden` if
 *                 the locked resolution is larger than the window,
 *                 matching OSRS fixed-mode behavior. The canvas is
 *                 rendered at the requested pixel resolution so the
 *                 GL backing store stays pixel-perfect.
 */
export interface GameResolutionSettings {
  mode: GameResolutionMode;
  width: number;
  height: number;
  presetId: ResolutionPresetId;
}

export interface ResolutionPreset {
  id: Exclude<ResolutionPresetId, 'fit' | 'custom'>;
  label: string;
  width: number;
  height: number;
}

/**
 * Non-persisted list of common resolution presets exposed in Display
 * settings. Trimmed to the three resolutions that cover >95% of real
 * use: OSRS Fixed (authentic size), 720p (most common stream/small
 * window), 1080p (dominant desktop). Anything else is reachable via
 * the Custom option.
 */
export const RESOLUTION_PRESETS: readonly ResolutionPreset[] = [
  { id: 'osrs-fixed', label: 'OSRS Fixed (765 × 503)', width: 765, height: 503 },
  { id: 'hd-720', label: '720p (1280 × 720)', width: 1280, height: 720 },
  { id: 'hd-1080', label: '1080p (1920 × 1080)', width: 1920, height: 1080 },
];

export const GAME_RESOLUTION_MIN = 320;
export const GAME_RESOLUTION_MAX = 7680;

export const DEFAULT_GAME_RESOLUTION: GameResolutionSettings = {
  mode: 'fit',
  width: 765,
  height: 503,
  presetId: 'fit',
};

/**
 * How large the Fixed layout draws its client.
 *
 * Fixed owns the frame's aspect ratio outright, so unlike the resizable layouts
 * there is no width x height to pick — only how many times over the authentic
 * 765x503 client is drawn. Any float in [FIXED_SCALE_MIN, FIXED_SCALE_MAX] is
 * allowed; 'fit' fills the window at the client's aspect ratio.
 * 'stretch' fills the window on both axes, distorting the client, as RuneLite's
 * Stretched Mode does with Keep aspect ratio off (see `placeFixedFrame`).
 *
 * A chosen multiple is preserved even when the window cannot contain it.
 * Only 'fit' and 'stretch' allow the client to shrink with the window.
 */
export type FixedLayoutScale = 'fit' | 'stretch' | number;

export interface PersistedSettings {
  speedMultiplier: number;
  autoAdvance: boolean;
  pauseWhenUnfocused: boolean;
  /**
   * Simulated input latency in milliseconds. Models real-game network lag:
   * an action is applied to the engine on the first tick boundary that begins
   * after `sendTime + inputLagMs`, so a click late in a tick can slip to the
   * next tick. `0` (default) = instant, matching zero-latency behavior. Only
   * takes effect during real-time (auto-advance) play. See inputLagBuffer.ts.
   */
  inputLagMs: number;
  /** Count down before each live fight run starts; see useFightStartCountdown. */
  fightStartCountdown: boolean;
  /** The countdown's length in whole game ticks, {@link FIGHT_START_COUNTDOWN_TICKS_MIN}..MAX. */
  fightStartCountdownTicks: number;
  showCoordinates: boolean;
  showWaveTiles: boolean;
  showDamageTiles: boolean;
  showFireballDangerTiles: boolean;
  smoothTerrain: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
  rendererType: 'webgl' | 'canvas2d';
  /**
   * Mechanics overrides per encounter, plus the account-wide player toggles under
   * {@link PLAYER_MECHANICS_KEY}. Keyed by the VARIANT kind (`yama_p3_forfeit_breath`),
   * not the base kind, for the same reason as `startingHpPerEncounter` below: a variant
   * declares its own toggles and defaults, so one contract's overrides must not speak
   * for its siblings. Nothing reads a parent entry underneath a variant's.
   */
  mechanicsConfigPerEncounter: Record<string, Partial<MechanicsConfig>>;
  /**
   * Starting hitpoints per encounter kind, for the variants that offer the control.
   * Keyed by the VARIANT kind (`yama_p3_bloodied`), not the base kind: it is one
   * contract's setting, and the base fight has no field to write it from.
   */
  startingHpPerEncounter: Record<string, number>;
  /**
   * The run modifiers the player chose per encounter kind (keyed like {@link mechanicsConfigPerEncounter}).
   * An entry is the player's whole selection, kept as made, so `{}` means every modifier off and one
   * equal to the default stays theirs; a kind with no entry takes its descriptor's `defaultModifiers`
   * for the run's setup. Only a reset removes an entry.
   */
  modifiersPerEncounter: Record<string, EncounterModifierSelection>;
  /** The {@link MODIFIER_SETTINGS_VERSION} {@link modifiersPerEncounter} was last migrated to. */
  modifierSettingsVersion: number;
  logLevel: 'none' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  gamePanelPosition: UIPosition;
  minimapPosition: UIPosition;
  /**
   * Position of the Compact Orbs block, kept separate from
   * `minimapPosition`. The two are different-sized widgets: the compact block
   * is a few orb frames, the vanilla minimap a 244x166 panel. Sharing one
   * position meant dragging either one moved the other, and the compact
   * block's nav-clearing placement leaked onto the minimap.
   */
  compactOrbsPosition: UIPosition;
  infoboxPosition: UIPosition | null;
  /**
   * Where the infobox strip is pinned. Surfaced as the "Infobox position"
   * control in Settings → Interface.
   */
  infoboxPinTarget: InfoboxPinTarget;
  uiScale: number;
  /**
   * The Stretched Mode plugin's own switch. Off renders the game UI and the overlays at
   * 100% and Fixed at its native 765x503, while `uiScale` and
   * `fixedLayoutScale` keep the user's values for when it comes back on.
   */
  stretchedModePluginEnabled: boolean;
  /**
   * The Stretched Mode plugin's Auto sizing of the top chrome (launchers, panes, Plugins), replay bar and plugin
   * overlays. Off shows them at 100%; the game UI scale is not affected. Shared by desktop
   * and mobile: Auto already follows the window, which is what differs between them.
   */
  autoOverlayScaleEnabled: boolean;
  showTickCounter: boolean;
  showTickCounterOverhead: boolean;
  tickCounterAbovePrayerIcon: boolean;
  showTickCounterInfobox: boolean;
  tickCounterMax: number;
  tickCounterFontSize: number;
  tickCounterColors: TickColorOverrides;
  tickCounterOffsetX: number;
  tickCounterOffsetY: number;
  showNpcClickbox: boolean;
  showTickTiming: boolean;
  showDetailedDps: boolean;
  /** DPS Overlay's Detailed DPS option. `showDetailedDps` above is the plugin's own switch, not this. */
  dpsOverlayShowDetails: boolean;
  /** Detailed DPS overlay position. `null` = its default slot. */
  detailedDpsPosition: UIPosition | null;
  showSoundDebug: boolean;
  showCameraDebug: boolean;
  showModifierKeys: boolean;
  attackStylePerCategory: Record<string, number>;
  showShortcutHints: boolean;
  disabledShortcutHints: string[];
  masterVolume: number;
  sfxVolume: number;
  areaVolume: number;
  muteWhenUnfocused: boolean;
  hideHardwareAccelWarning: boolean;
  /** The mobile start screen's one-time touch notes have been seen (see `useMobileEntry`). */
  hideMobileWarning: boolean;
  renderScaleHardware: number;
  renderScaleSoftware: number;
  antiAliasing: 'auto' | 'on' | 'off';
  showFps: boolean;
  /**
   * Maximum frames per second the 3D viewport renders at. `0` means
   * uncapped (render every animation frame). A positive value throttles
   * the render loop to that rate, skipping GPU work on frames that arrive
   * faster than the budget — this genuinely lowers GPU/CPU usage rather
   * than just unlocking the browser's vsync ceiling.
   */
  fpsCap: number;
  cameraPluginEnabled: boolean;
  cameraVerticalCamera: boolean;
  cameraInvertYaw: boolean;
  cameraInvertPitch: boolean;
  /**
   * How far past the game's own zoom limit the expanded limit reaches, as the 0-8
   * strength described at {@link innerZoomLimitForLevel} rather than the zoom
   * value it becomes. 0 is the game's own limit, which is why this needs no
   * companion on/off flag the way it did when it was a fixed expansion.
   */
  cameraInnerZoomLevel: number;
  cameraOuterZoomLimit: number;
  /**
   * Multiplies the KEYBOARD rotate/tilt rate only, matching RuneLite's
   * `CameraConfig.cameraSpeed`. The middle-drag rate is `cameraDragSpeed`; the
   * UI names both after their input for that reason.
   */
  cameraSpeed: number;
  /** Multiplies the middle-mouse drag rotate rate. See DRAG_DEGREES_PER_PIXEL. */
  cameraDragSpeed: number;
  cameraRightClickMovesCamera: boolean;
  cameraZoomIncrement: number;
  gameResolution: GameResolutionSettings;
  /**
   * Which OSRS client display mode the frame is laid out as.
   *
   * - 'modern' (default): the simulator's original chrome, which is already
   *   pixel-identical to the real client's Resizable / Modern layout.
   * - 'classic': Resizable / Classic layout — the taller side column with a
   *   tab row above and below the panel.
   * - 'fixed': the 765x503 client, drawn at `fixedLayoutScale`. `gameResolution`
   *   is ignored while this is selected, and deliberately left untouched so it
   *   comes back on return to a resizable layout.
   * - 'mobile': the mobile client's layout (interface group 601). Forced on phones
   *   and tablets, where it is the only layout; selectable on desktop.
   *
   * Geometry lives in src/layout/osrsClientLayout.ts and osmClientLayout.ts.
   */
  clientLayoutMode: ClientLayoutMode;
  /**
   * Read only while `clientLayoutMode` is 'fixed'; the resizable layouts use
   * `gameResolution` instead.
   *
   * Not platform-overridable: an oversized multiple already degrades to a plain
   * aspect fit on a small screen, so a phone needs no separate stored value.
   */
  fixedLayoutScale: FixedLayoutScale;
  /**
   * Floors Fit Window's multiple, and each of Stretch to Window's axes, to a whole number
   * (RuneLite StretchedModeConfig.integerScaling). No effect on an explicit multiple.
   */
  fixedLayoutIntegerScaling: boolean;
  /**
   * Whether the chatbox is open, in every desktop layout (Mobile draws none). Named for
   * the Fixed layout, where it first appeared; one setting serves all of them, so the
   * key stays as stored.
   *
   * Defaults on, because the real client has no way to hide it and this is
   * what makes Fixed look like Fixed. Off gives Fixed's 3D scene the chatbox's
   * 165 rows back, and leaves the resizable layouts only the controls row.
   */
  fixedChatboxVisible: boolean;
  /**
   * The client's "Transparent chatbox" (varbit 4608), read only by the resizable layouts: the
   * client neither applies nor toggles it in Fixed, so Fixed stays opaque.
   *
   * Defaults ON, unlike the client (the varbit starts at 0, opaque): the
   * resizable chatbox sits over the scene, and transparent keeps the most of it in view. A stored
   * false is a choice and is kept.
   */
  transparentChatbox: boolean;
  /** Resizable layouts. Half-opacity gameplay backing; text settings stay opaque. */
  transparentSidePanel: boolean;
  /** Modern only. Clicks always toggle; hotkeys only close when this is enabled. */
  hotkeysCloseSidePanel: boolean;
  /**
   * The client's "Click through transparent chatbox" (Settings > Interfaces > Resizable): clicks
   * on a transparent chatbox's message area reach the scene behind it; its tabs and scrollbar stay
   * buttons, and the wheel still scrolls the chat. The game clicks through by default (its
   * varbit, 2570, starts at 0), and so does this. Read only while transparent.
   */
  clickThroughTransparentChatbox: boolean;
  hasCompletedTutorial: boolean;
  attackTimerMetronomeEnabled: boolean;
  /** Attack Timer Metronome: the drain bar beneath the health bar. */
  attackTimerMetronomeShowBar: boolean;
  /** Attack Timer Metronome: the ticks-until-next-attack number over the head, placed like the Tick Counter's. */
  attackTimerMetronomeShowTicks: boolean;
  attackTimerMetronomeFontSize: number;
  attackTimerMetronomeAbovePrayerIcon: boolean;
  attackTimerMetronomeOffsetX: number;
  attackTimerMetronomeOffsetY: number;
  npcAttackTimerMetronomeEnabled: boolean;
  /**
   * Custom Menu Swaps plugin: one left-click swap rule per line, in the syntax
   * of the RuneLite plugin-hub plugin of the same name. Stored as the raw text
   * the user typed rather than parsed rules, so an in-progress or malformed line
   * survives a reload instead of being silently dropped.
   */
  customMenuSwapsEnabled: boolean;
  customMenuSwaps: string;
  instantInventoryEnabled: boolean;
  /**
   * Instant Prayer clears conflicting local highlights before server receipt.
   * Clicked prayers still highlight immediately when this is disabled.
   */
  instantPrayerEnabled: boolean;
  /**
   * Prayer plugin (RuneLite's): sweeps a 1px line across the prayer orb once
   * per game tick. Defaults ON, and a stored blob without this key reads as on
   * too, since `load()` spreads the defaults underneath it.
   *
   * RuneLite's own copy calls this the "prayer flick helper", but that name is
   * taken here by a different plugin (the tick-bar panel below), so the UI uses
   * RuneLite's other vocabulary for it: "pray flick" on the "prayer orb".
   * - `prayerFlickOrbEnabled` — the sweep itself (RuneLite's PRAYER_ORB flick
   *   location; this port ships no PRAYER_BAR).
   * - `prayerFlickAlwaysOn` — RuneLite's "Never hide prayer flick helper":
   *   keeps the sweep up even with no prayer burning.
   */
  prayerEnabled: boolean;
  prayerFlickOrbEnabled: boolean;
  prayerFlickAlwaysOn: boolean;
  /**
   * Prayer Flick Helper plugin: one bar per game tick, marking where each
   * prayer click landed inside the tick and where it arrived after simulated
   * input lag. Read-only overlay. This key is the panel's only switch — the orb
   * sweep above belongs to the Prayer plugin, not to this one.
   */
  prayerFlickEnabled: boolean;
  tickAudioMetronomeEnabled: boolean;
  /** Alternate a lower tock on odd ticks instead of the same tick every tick. */
  tickAudioMetronomeTock: boolean;
  /** Metronome channel volume; the master volume scales it too. */
  tickAudioMetronomeVolume: number;
  /**
   * Tile Grid plugin: lines along every tile edge on the 3D ground, under the tile
   * markers and outlines.
   */
  tileGridEnabled: boolean;
  /** `#rrggbb`. */
  tileGridColor: string;
  /** 0–1. */
  tileGridOpacity: number;
  /** On the shared 0.5–10 line-width UI scale. */
  tileGridWidth: number;
  /** Prayer Flick Helper overlay position. `null` = its default slot. */
  prayerFlickPosition: UIPosition | null;
  /**
   * Status Bars plugin (RuneLite's). This port ships only its DEFAULT pair of
   * bars, so it deliberately persists no bar mode, restore preview, width or
   * combat-hide delay — the rest of RuneLite's config is unported, not missing.
   */
  statusBarsEnabled: boolean;
  /**
   * Whether those bars carry the current hitpoints and prayer under their
   * icons. Defaults ON: it is a child of a plugin that is already off by
   * default, so shipping it off too would hide the counters from everyone who
   * switches the plugin on and never opens its settings.
   */
  statusBarsShowValues: boolean;
  /** Entity Hider plugin (RuneLite's): the switch, and what it hides while on. Presentation only. */
  entityHiderEnabled: boolean;
  entityHider: EntityHiderOptions;
  /** TzHaar HP Tracker plugin (the plugin-hub one), the basics of its config. Presentation only. */
  tzhaarHpTrackerEnabled: boolean;
  tzhaarHpTracker: TzhaarHpTrackerOptions;
  /** Inferno Additions plugin: Tzhaar/Colo Additions' (plugin hub) pillar options for the Inferno. Presentation only. */
  infernoAdditionsEnabled: boolean;
  infernoAdditions: PillarAdditionsOptions;
  /** Colosseum Additions plugin: the same options for the Colosseum's pillars. Presentation only. */
  colosseumAdditionsEnabled: boolean;
  colosseumAdditions: PillarAdditionsOptions;
  /**
   * Zuk set timer overlay position. `null` = never dragged, so the overlay's own
   * default slot applies. Replay presentation frames carry it as `panels.zukSetTimer` on a strict
   * schema (`src/replay/format/presentationFormat.ts`), and the recorder fills that from here.
   */
  zukSetTimerPosition: UIPosition | null;
  /**
   * Compact Orbs plugin: hides the minimap and packs the four orbs into a
   * compact block (modeled on the RuneLite plugin-hub plugin). The layout and
   * slot order are configurable from the plugin's settings.
   */
  compactOrbsEnabled: boolean;
  compactOrbsLayout: CompactOrbsLayout;
  compactOrbsOrder: CompactOrbId[];
  infoboxTextOutlineEnabled: boolean;
  infoboxTextOutlineColor: string;
  /**
   * Touch input (touch pointers, see `isTouchPointer`): the hold time, in ms, that opens the
   * right-click menu, for the world and the panels alike. The mobile client's "Long Tap
   * Delay". Mirrored into `src/input/touchPrefs.ts`, where the gestures read it.
   */
  touchLongPressMs: number;
  /** Touch input: minimum row height, in CSS px, of a menu opened by a long-press. */
  touchMenuRowHeight: number;
  /** Touch input: one short vibration when a long-press opens a menu. */
  touchHapticsEnabled: boolean;
  /**
   * Mobile layout: the five hotkey slots, each an enum 5607 hotkey id
   * or 0 for empty. One loadout; the native client keeps three.
   */
  mobileHotkeys: OsmHotkeySlot[];
  /**
   * Mobile layout: "Hotkeys open side panels on the left". See `osmSidePanelOnLeft`.
   */
  mobileHotkeysOpenOnLeft: boolean;
  /**
   * Mobile layout: the native "Interface scaling" slider, in percent (175-400 in steps of
   * 25). One input to the chrome's scale; see `osmChromeScale`.
   */
  mobileInterfaceScaling: number;
  /**
   * Where the user has put the simulator's own overlays IN THE MOBILE LAYOUT, on any device.
   * Chosen by the layout on screen, never by device class (see {@link applyLayoutPlacement}),
   * so the desktop positions above are never read or written while Mobile is drawn, and a
   * Mobile arrangement never starts from desktop coordinates. Absent or null means the
   * computed default (osmHud's `placeOsmHud`). The Mobile layout's other overlays have no
   * stored place: the chrome, XP drops, buff bar and boss bar sit where the game puts them.
   */
  mobileLayoutPlacement: MobileLayoutPlacement;
  /**
   * Per-platform overrides applied when the user is on a mobile viewport.
   *
   * Only the keys listed in {@link PLATFORM_OVERRIDE_KEYS} are allowed here.
   * Desktop reads ignore this field entirely. Persisted in the same
   * `osrs-yama-settings` blob, so storage needs no schema change.
   */
  mobileOverrides?: PlatformOverrides;
}

/**
 * Settings whose desktop value would be wrong, awkward, or actively harmful
 * on a mobile viewport. Device preferences only: placement belongs to the layout, not the
 * device, and lives in {@link MOBILE_LAYOUT_PLACEMENT_KEYS}. Adding or removing entries here is the ONLY change
 * required to extend the platform-fork model — read merging and write routing
 * both drive off this single list.
 */
export const PLATFORM_OVERRIDE_KEYS = [
  'uiScale',
  'rendererType',
  'renderScaleHardware',
  'renderScaleSoftware',
  'cameraPluginEnabled',
  'cameraVerticalCamera',
  'cameraInvertYaw',
  'cameraInvertPitch',
  'cameraInnerZoomLevel',
  'cameraOuterZoomLimit',
  'cameraSpeed',
  'cameraDragSpeed',
  'cameraRightClickMovesCamera',
  'cameraZoomIncrement',
  'showShortcutHints',
  'gameResolution',
  'clientLayoutMode',
] as const satisfies readonly (keyof PersistedSettings)[];

export type PlatformOverrideKey = (typeof PLATFORM_OVERRIDE_KEYS)[number];

export type PlatformOverrides = Partial<Pick<PersistedSettings, PlatformOverrideKey>>;

const PLATFORM_OVERRIDE_KEY_SET: ReadonlySet<keyof PersistedSettings> = new Set(PLATFORM_OVERRIDE_KEYS);

/** The simulator's own overlays the Mobile layout lets the user move (in its edit mode). */
export interface MobileLayoutPlacement {
  readonly detailedDps?: UIPosition;
  readonly prayerFlick?: UIPosition;
  readonly zukSetTimer?: UIPosition;
}

/** Each stored position that reads from {@link PersistedSettings.mobileLayoutPlacement} in Mobile. */
const MOBILE_LAYOUT_PLACEMENT_KEYS = {
  detailedDpsPosition: 'detailedDps',
  prayerFlickPosition: 'prayerFlick',
  zukSetTimerPosition: 'zukSetTimer',
} as const satisfies Partial<Record<keyof PersistedSettings, keyof MobileLayoutPlacement>>;

type MobileLayoutPlacementKey = keyof typeof MOBILE_LAYOUT_PLACEMENT_KEYS;

function isMobileLayoutPlacementKey(key: keyof PersistedSettings): key is MobileLayoutPlacementKey {
  return Object.hasOwn(MOBILE_LAYOUT_PLACEMENT_KEYS, key);
}

/**
 * Parses the stored bucket. Only concrete positions are kept: null and absent both mean the
 * computed default, so storing a null would only be a second way to say nothing.
 */
function normalizeMobileLayoutPlacement(raw: unknown): MobileLayoutPlacement {
  const parsed = UnknownRecordSchema.safeParse(raw);
  if (!parsed.success) return {};
  const next: { -readonly [K in keyof MobileLayoutPlacement]: UIPosition } = {};
  for (const field of Object.values(MOBILE_LAYOUT_PLACEMENT_KEYS)) {
    const position = parseStoredPosition(parsed.data[field]);
    if (position) next[field] = position;
  }
  return next;
}

/**
 * The positions the layout ON SCREEN reads: in the Mobile layout the placement keys come from
 * the Mobile bucket (null when it holds none), everywhere else from the stored desktop value.
 * Runs after the device overrides, which are what make a phone's layout Mobile.
 */
function applyLayoutPlacement(settings: PersistedSettings): PersistedSettings {
  if (settings.clientLayoutMode !== 'mobile') return settings;
  const bucket = settings.mobileLayoutPlacement;
  return {
    ...settings,
    detailedDpsPosition: bucket.detailedDps ?? null,
    prayerFlickPosition: bucket.prayerFlick ?? null,
    zukSetTimerPosition: bucket.zukSetTimer ?? null,
  };
}

function isPlatformOverrideKey(key: keyof PersistedSettings): key is PlatformOverrideKey {
  return PLATFORM_OVERRIDE_KEY_SET.has(key);
}

export const DEFAULT_GAME_PANEL_POSITION: UIPosition = { x: 0, y: 0, anchorX: 'right', anchorY: 'bottom' };
export const DEFAULT_MINIMAP_POSITION: UIPosition = { x: 0, y: 0, anchorX: 'right', anchorY: 'top' };
/**
 * Compact Orbs default. Offset below the floating top-right nav strip (the
 * Plugins toggle, measured at y 24-53 on desktop and y 8-43 on mobile) so the
 * block does not open underneath it. Only a starting point - the user can drag
 * the block anywhere, including back under the nav.
 */
export const DEFAULT_COMPACT_ORBS_POSITION: UIPosition = { x: 0, y: 60, anchorX: 'right', anchorY: 'top' };
/**
 * `null` = follow the computed default (strip flush above the game panel,
 * left-aligned with it). The default is computed at render time in
 * InfoBoxPanel so it tracks strip-width changes and re-uses the GamePanel's
 * actual default slot. Once the user drags the strip, this becomes a
 * concrete UIPosition and is persisted.
 */
export const DEFAULT_INFOBOX_POSITION: UIPosition | null = null;
/** `null` = the set timer overlay was never dragged; it owns its own default slot. */
export const DEFAULT_ZUK_SET_TIMER_POSITION: UIPosition | null = null;
/**
 * `null` = follow the Prayer Flick Helper overlay's own default slot, which the
 * component owns. Becomes a concrete UIPosition once the player Alt+drags it.
 */
export const DEFAULT_PRAYER_FLICK_POSITION: UIPosition | null = null;
/**
 * `null` = follow the Detailed DPS overlay's own default slot, which the
 * component owns. Becomes a concrete UIPosition once the player Alt+drags it.
 */
export const DEFAULT_DETAILED_DPS_POSITION: UIPosition | null = null;
export const DEFAULT_UI_SCALE = 1.0;
export const FIGHT_START_COUNTDOWN_TICKS_MIN = 1;
export const FIGHT_START_COUNTDOWN_TICKS_MAX = 5;

export const PERSISTED_SETTINGS_DEFAULTS: PersistedSettings = {
  speedMultiplier: 1,
  autoAdvance: true,
  pauseWhenUnfocused: true,
  inputLagMs: 20,
  fightStartCountdown: true,
  fightStartCountdownTicks: 3,
  showCoordinates: false,
  showWaveTiles: false,
  showDamageTiles: false,
  showFireballDangerTiles: false,
  smoothTerrain: false,
  brightness: 0.6,
  contrast: 1.0,
  saturation: 1.0,
  rendererType: 'webgl',
  logLevel: 'warn',
  mechanicsConfigPerEncounter: {},
  startingHpPerEncounter: {},
  modifiersPerEncounter: {},
  // Nothing saved yet has nothing to migrate.
  modifierSettingsVersion: MODIFIER_SETTINGS_VERSION,
  gamePanelPosition: DEFAULT_GAME_PANEL_POSITION,
  minimapPosition: DEFAULT_MINIMAP_POSITION,
  compactOrbsPosition: DEFAULT_COMPACT_ORBS_POSITION,
  infoboxPosition: DEFAULT_INFOBOX_POSITION,
  infoboxPinTarget: 'inventory',
  uiScale: DEFAULT_UI_SCALE,
  stretchedModePluginEnabled: true,
  autoOverlayScaleEnabled: true,
  showTickCounter: true,
  showTickCounterOverhead: false,
  tickCounterAbovePrayerIcon: false,
  showTickCounterInfobox: true,
  tickCounterMax: 4,
  tickCounterFontSize: 24,
  tickCounterColors: {},
  tickCounterOffsetX: 0,
  tickCounterOffsetY: 0,
  showNpcClickbox: false,
  showTickTiming: false,
  showDetailedDps: false,
  dpsOverlayShowDetails: false,
  detailedDpsPosition: DEFAULT_DETAILED_DPS_POSITION,
  showSoundDebug: false,
  showCameraDebug: false,
  showModifierKeys: false,
  attackStylePerCategory: {},
  showShortcutHints: true,
  disabledShortcutHints: [],
  masterVolume: 0.1,
  sfxVolume: 0.1,
  areaVolume: 0.1,
  muteWhenUnfocused: true,
  hideHardwareAccelWarning: false,
  hideMobileWarning: false,
  renderScaleHardware: 1.0,
  renderScaleSoftware: 0.5,
  antiAliasing: 'auto',
  showFps: true,
  fpsCap: 144,
  cameraPluginEnabled: true,
  cameraVerticalCamera: false,
  cameraInvertYaw: false,
  cameraInvertPitch: false,
  cameraInnerZoomLevel: INNER_ZOOM_LEVEL_MIN,
  cameraOuterZoomLimit: 0,
  cameraSpeed: 1,
  cameraDragSpeed: 1,
  cameraRightClickMovesCamera: false,
  cameraZoomIncrement: 25,
  gameResolution: DEFAULT_GAME_RESOLUTION,
  clientLayoutMode: 'modern',
  fixedLayoutScale: 'fit',
  fixedLayoutIntegerScaling: false,
  fixedChatboxVisible: true,
  transparentChatbox: true,
  transparentSidePanel: true,
  hotkeysCloseSidePanel: false,
  clickThroughTransparentChatbox: true,
  hasCompletedTutorial: false,
  attackTimerMetronomeEnabled: false,
  attackTimerMetronomeShowBar: true,
  attackTimerMetronomeShowTicks: false,
  // Matches the Tick Counter's default: both numbers share the overhead font.
  attackTimerMetronomeFontSize: 24,
  attackTimerMetronomeAbovePrayerIcon: false,
  attackTimerMetronomeOffsetX: 0,
  attackTimerMetronomeOffsetY: 0,
  npcAttackTimerMetronomeEnabled: false,
  customMenuSwapsEnabled: false,
  customMenuSwaps: '',
  instantInventoryEnabled: false,
  instantPrayerEnabled: true,
  prayerEnabled: true,
  prayerFlickOrbEnabled: true,
  prayerFlickAlwaysOn: false,
  prayerFlickEnabled: false,
  tickAudioMetronomeEnabled: false,
  tickAudioMetronomeTock: true,
  tickAudioMetronomeVolume: 1,
  tileGridEnabled: false,
  tileGridColor: DEFAULT_TILE_GRID_COLOR,
  tileGridOpacity: DEFAULT_TILE_GRID_OPACITY,
  tileGridWidth: DEFAULT_TILE_GRID_WIDTH,
  prayerFlickPosition: DEFAULT_PRAYER_FLICK_POSITION,
  statusBarsEnabled: false,
  statusBarsShowValues: true,
  entityHiderEnabled: false,
  entityHider: DEFAULT_ENTITY_HIDER_OPTIONS,
  tzhaarHpTrackerEnabled: false,
  tzhaarHpTracker: DEFAULT_TZHAAR_HP_TRACKER_OPTIONS,
  infernoAdditionsEnabled: false,
  infernoAdditions: DEFAULT_PILLAR_ADDITIONS_OPTIONS,
  colosseumAdditionsEnabled: false,
  colosseumAdditions: DEFAULT_PILLAR_ADDITIONS_OPTIONS,
  zukSetTimerPosition: DEFAULT_ZUK_SET_TIMER_POSITION,
  compactOrbsEnabled: false,
  compactOrbsLayout: DEFAULT_COMPACT_ORBS_LAYOUT,
  compactOrbsOrder: [...DEFAULT_COMPACT_ORBS_ORDER],
  infoboxTextOutlineEnabled: true,
  infoboxTextOutlineColor: '#000000',
  touchLongPressMs: DEFAULT_TOUCH_PREFS.longPressMs,
  touchMenuRowHeight: DEFAULT_TOUCH_PREFS.menuRowHeight,
  touchHapticsEnabled: DEFAULT_TOUCH_PREFS.hapticsEnabled,
  mobileHotkeys: [...JAGEX_BOSSING_HOTKEYS],
  mobileHotkeysOpenOnLeft: false,
  mobileInterfaceScaling: OSM_INTERFACE_SCALING_DEFAULT,
  mobileLayoutPlacement: {},
};

/**
 * Mobile-tuned defaults for platform-overridable settings.
 *
 * Only fields that genuinely benefit from a different mobile default appear
 * here. Anything missing falls through to the user's stored desktop value,
 * then to {@link PERSISTED_SETTINGS_DEFAULTS}. The user can always supersede
 * any entry by writing through {@link usePersistedSettings} on a mobile
 * viewport, which lands in `mobileOverrides`.
 */
export const MOBILE_PLATFORM_DEFAULTS: PlatformOverrides = {
  uiScale: DEFAULT_UI_SCALE,
  // Reduce GPU pressure on mobile devices without making things look bad.
  renderScaleHardware: 0.85,
  // The "camera plugin" is a WASD/keyboard movement helper — meaningless
  // on touch and clutters the plugin UI.
  cameraPluginEnabled: false,
  cameraVerticalCamera: false,
  // Keyboard-only shortcut hints would just confuse touch users.
  showShortcutHints: false,
  // On mobile we FORCE fit-window mode. Fixed-resolution letterboxing
  // on a phone would clip the game canvas to a tiny centered box with
  // huge dead space around it, and the Resolution picker is hidden on
  // mobile anyway (see Controls.tsx). Any stored desktop resolution
  // choice is ignored until the user switches back to desktop.
  gameResolution: { mode: 'fit', width: 765, height: 503, presetId: 'fit' },
  // The real mobile client has exactly one layout, so a phone or tablet always gets it.
  // The Layout picker is hidden on mobile too: a synced desktop choice of Fixed would
  // letterbox the phone to a 765x503 client with no control on screen to undo it.
  clientLayoutMode: 'mobile',
};

/**
 * A stored position, offsets clamped to the anchored edges. Extra keys are stripped rather
 * than refused as the wire's `.strict()` does: they say nothing about where the panel is.
 *
 * Returns null for anything else, which position fields with a computed default (the
 * infobox strip's auto-tracking placement) store as "follow the default". There is no honest
 * repair for a coordinate that is not a number: fabricating (0, 0) relocates a panel the user
 * placed, and the caller knows its own default.
 */
export function parseStoredPosition(raw: unknown): UIPosition | null {
  const parsed = ReplayUiPositionSchema.strip().safeParse(raw);
  if (!parsed.success) return null;
  return {
    x: Math.max(0, parsed.data.x),
    y: Math.max(0, parsed.data.y),
    anchorX: parsed.data.anchorX,
    anchorY: parsed.data.anchorY,
  };
}

export function normalizePosition(raw: unknown, fallback: UIPosition): UIPosition {
  return parseStoredPosition(raw) ?? { ...fallback };
}

/**
 * Parses a stored (untrusted) `mobileOverrides` blob from the settings
 * payload. Returns `undefined` if nothing survives so callers
 * can treat 'missing' and 'empty' identically.
 *
 * Exported for tests; called only from `load()` in production.
 */
export function normalizeMobileOverrides(raw: unknown): PlatformOverrides | undefined {
  const parsedSource = UnknownRecordSchema.safeParse(raw);
  if (!parsedSource.success) return undefined;
  const source = parsedSource.data;
  const next: PlatformOverrides = {};
  // Drop any keys that are not in the current allow-list. This protects against
  // a future where we narrow `PLATFORM_OVERRIDE_KEYS` and want orphaned data
  // to fall back to defaults rather than ride along forever.
  for (const key of PLATFORM_OVERRIDE_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (key === 'gameResolution') {
      if (UnknownRecordSchema.safeParse(value).success) writeOverridableKey(next, key, normalizeGameResolution(value));
    } else if (key === 'clientLayoutMode') {
      if (isClientLayoutMode(value)) writeOverridableKey(next, key, value);
    } else if (key === 'uiScale') {
      if (ReplayUiScaleSchema.safeParse(value).success) writeOverridableKey(next, key, normalizeUiScale(value));
    } else if (key === 'rendererType') {
      if (value === 'webgl' || value === 'canvas2d') writeOverridableKey(next, key, value);
    } else if (key === 'cameraInnerZoomLevel') {
      if (typeof value === 'number' && Number.isFinite(value)) {
        writeOverridableKey(next, key, normalizeInnerZoomLevel(value));
      }
    } else {
      const schema = PersistedSettingsShape[key];
      const parsed = (schema instanceof z.ZodCatch ? schema.removeCatch() : schema).safeParse(value);
      if (parsed.success) writeOverridableKey(next, key, parsed.data);
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

const VALID_PRESET_IDS: readonly ResolutionPresetId[] = ['fit', 'osrs-fixed', 'hd-720', 'hd-1080', 'custom'];

/**
 * Stored settings are spread in unvalidated, so an out-of-band value could
 * otherwise reach `Grid` — including `'none'`, the UI harness's no-viewport
 * mode, which would leave a real user staring at an empty scene.
 */
function normalizeRendererType(value: unknown): PersistedSettings['rendererType'] {
  return value === 'webgl' || value === 'canvas2d' ? value : PERSISTED_SETTINGS_DEFAULTS.rendererType;
}

/**
 * Both are recorded into every replay's presentation track, whose schema is exact, so a
 * hand-edited or out-of-range value here is not a cosmetic problem: `uiScale` scales the
 * whole panel layout a recorded cursor is placed against, and `speedMultiplier` divides
 * into every timestamp the recorder writes.
 */
function normalizeUiScale(value: unknown): number {
  const scale = ReplayUiScaleSchema.catch(PERSISTED_SETTINGS_DEFAULTS.uiScale).parse(value);
  return Math.min(3, Math.max(1, scale));
}

function normalizeSpeedMultiplier(value: unknown): number {
  return SPEED_MULTIPLIERS.find((speed) => speed === value) ?? PERSISTED_SETTINGS_DEFAULTS.speedMultiplier;
}

/**
 * The stored blob is hand-editable, and both ingress paths
 * spread it over the defaults — so a `null` or an array here replaces the default `{}` and
 * the first `overrides[kind]` lookup throws. Values that are not usable hitpoints are
 * dropped rather than kept, because the consumer treats a present key as an override and
 * would otherwise carry a string into the player's hitpoints.
 */
function normalizeStartingHpPerEncounter(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...PERSISTED_SETTINGS_DEFAULTS.startingHpPerEncounter };
  }
  const result: Record<string, number> = {};
  for (const [kind, hp] of Object.entries(value)) {
    if (typeof hp === 'number' && Number.isFinite(hp) && hp >= 1) result[kind] = Math.floor(hp);
  }
  return result;
}

const TICK_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * Anything that is not a canonical `1..TICK_CYCLE_MAX` key holding a `#rrggbb`
 * string is dropped. A malformed color reaches a CSS `color` assignment, where
 * it is ignored and the tick silently inherits; a key no cycle length can
 * produce (`'0'`, `'01'`, `'999'`) has no chip to edit it but still counts
 * toward the row's modified state.
 *
 * Keys ABOVE the current cycle length are deliberately kept: shortening the
 * cycle and lengthening it again restores the colors rather than losing them.
 */
export function normalizeTickCounterColors(value: unknown): TickColorOverrides {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [tick, color] of Object.entries(value)) {
    if (!/^[1-9]\d*$/.test(tick) || Number(tick) > TICK_CYCLE_MAX) continue;
    if (typeof color === 'string' && TICK_COLOR_PATTERN.test(color)) result[tick] = color.toLowerCase();
  }
  return result;
}

function clampStoredInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** {@link clampStoredInt}, then snapped to the nearest `step` above `min`, as a stepped slider writes. */
function clampStoredStep(value: unknown, min: number, max: number, step: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const snapped = min + Math.round((value - min) / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

/** Exactly five slots; an unknown hotkey in one empties that slot rather than the loadout. */
export function normalizeMobileHotkeys(value: unknown): OsmHotkeySlot[] {
  if (!Array.isArray(value) || value.length !== OSM_HOTKEY_SLOTS) return [...JAGEX_BOSSING_HOTKEYS];
  return value.map((slot) => (isOsmHotkeySlot(slot) ? slot : OSM_HOTKEY_EMPTY));
}

/** A missing or unknown `presetId` makes the whole value the default resolution. */
function normalizeGameResolution(value: unknown): GameResolutionSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_GAME_RESOLUTION };
  const v = value as Partial<GameResolutionSettings>;
  if (typeof v.presetId !== 'string' || !(VALID_PRESET_IDS as readonly string[]).includes(v.presetId)) {
    return { ...DEFAULT_GAME_RESOLUTION };
  }
  const mode: GameResolutionMode = v.mode === 'fixed' ? 'fixed' : 'fit';
  const rawW = typeof v.width === 'number' && Number.isFinite(v.width) ? v.width : DEFAULT_GAME_RESOLUTION.width;
  const rawH = typeof v.height === 'number' && Number.isFinite(v.height) ? v.height : DEFAULT_GAME_RESOLUTION.height;
  const width = Math.round(Math.max(GAME_RESOLUTION_MIN, Math.min(GAME_RESOLUTION_MAX, rawW)));
  const height = Math.round(Math.max(GAME_RESOLUTION_MIN, Math.min(GAME_RESOLUTION_MAX, rawH)));
  return { mode, width, height, presetId: v.presetId as ResolutionPresetId };
}

/**
 * Fixed-layout scale is stored as a bare `'fit'`, `'stretch'` or a number, so
 * anything else in the blob — another string, a NaN, a negative — must land back
 * on 'fit' rather than reach `fitFixedFrame` and collapse the frame to nothing.
 *
 * Exported for tests; called only from `load()` in production.
 */
export function normalizeFixedLayoutScale(value: unknown): FixedLayoutScale {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(FIXED_SCALE_MIN, Math.min(FIXED_SCALE_MAX, value));
  }
  return value === 'stretch' ? 'stretch' : 'fit';
}

/**
 * A NaN or a string out of the blob survives `Projection3D`'s own clamp —
 * `Math.min(NaN, …)` is NaN — and the camera then projects nothing at all rather
 * than being held at a bounded zoom. The picker only ever writes a whole number in
 * range, so rounding here costs nothing.
 *
 * Exported for tests; called only from `load()` in production.
 */
export function normalizeInnerZoomLevel(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return PERSISTED_SETTINGS_DEFAULTS.cameraInnerZoomLevel;
  }
  return Math.max(INNER_ZOOM_LEVEL_MIN, Math.min(INNER_ZOOM_LEVEL_MAX, Math.round(value)));
}

/**
 * The frame size the user explicitly asked for, or null when they asked the
 * frame to fill the window.
 *
 * The two families of layout state that wish differently — Fixed as a multiple
 * of its 765x503 client, the resizable layouts as an outright resolution — and
 * three separate places need the answer (the too-small warning, its copy, and
 * the resize-window action), so the rule lives here rather than in each.
 */
export function resolveRequestedFrameSize(
  clientLayoutMode: ClientLayoutMode,
  gameResolution: GameResolutionSettings,
  fixedLayoutScale: FixedLayoutScale,
): Size | null {
  if (clientLayoutMode === 'fixed') {
    return typeof fixedLayoutScale === 'number' ? fixedFrameSizeAtScale(fixedLayoutScale) : null;
  }
  return gameResolution.mode === 'fixed' ? { width: gameResolution.width, height: gameResolution.height } : null;
}

const UnknownRecordSchema = z.record(z.string(), z.unknown());
const FpsCapSchema = z.union([
  z.literal(0),
  z.literal(30),
  z.literal(60),
  z.literal(90),
  z.literal(120),
  z.literal(144),
]);
function boundedNumber(min: number, max: number, fallback: number): z.ZodCatch<z.ZodNumber> {
  return z.number().finite().min(min).max(max).catch(fallback);
}

function positiveNumber(fallback: number): z.ZodCatch<z.ZodNumber> {
  return z.number().finite().positive().catch(fallback);
}

function parseMechanicsConfigPerEncounter(value: unknown): Record<string, Partial<MechanicsConfig>> {
  const parsed = UnknownRecordSchema.safeParse(value);
  if (!parsed.success) return {};
  const result: Record<string, Partial<MechanicsConfig>> = {};
  for (const [encounter, rawConfig] of Object.entries(parsed.data)) {
    const configRecord = UnknownRecordSchema.safeParse(rawConfig);
    if (!configRecord.success) continue;
    const config: Partial<MechanicsConfig> = {};
    for (const [key, setting] of Object.entries(configRecord.data)) {
      if (typeof setting === 'boolean' || (typeof setting === 'string' && !BOOLEAN_MECHANICS_KEY_SET.has(key))) {
        config[key] = setting;
      }
    }
    result[encounter] = config;
  }
  // A retired kind's choices (Zuk's toggles) move onto the kind that owns it, as its saved loadout
  // does (`consolidateRetiredLoadouts`): on a shared key the retired kind's choice wins.
  return consolidateRetiredEncounterKinds(result, (owned, retired) => ({ ...owned, ...retired })).map;
}

/**
 * Each kind's saved selection, keeping only tiers 1-3 (whether a modifier still offers that tier is
 * the reader's `filterModifierSelection`). An entry that is not a record is dropped, which reverts
 * the kind to its descriptor default; an empty record is kept, as it is the explicit all-off choice.
 */
function parseModifiersPerEncounter(value: unknown): Record<string, EncounterModifierSelection> {
  const parsed = UnknownRecordSchema.safeParse(value);
  if (!parsed.success) return {};
  const result: Record<string, EncounterModifierSelection> = {};
  for (const [encounter, rawSelection] of Object.entries(parsed.data)) {
    const selection = UnknownRecordSchema.safeParse(rawSelection);
    if (!selection.success) continue;
    const tiers: Record<string, EncounterModifierTier> = {};
    for (const [id, tier] of Object.entries(selection.data)) {
      if (tier === 1 || tier === 2 || tier === 3) tiers[id] = tier;
    }
    result[encounter] = tiers;
  }
  return result;
}

function parseAttackStylePerCategory(value: unknown): Record<string, number> {
  const parsed = UnknownRecordSchema.safeParse(value);
  if (!parsed.success) return {};
  const result: Record<string, number> = {};
  for (const [category, styleIndex] of Object.entries(parsed.data)) {
    if (
      typeof styleIndex === 'number' &&
      Number.isFinite(styleIndex) &&
      Number.isInteger(styleIndex) &&
      styleIndex >= 0
    ) {
      result[category] = styleIndex;
    }
  }
  return result;
}

const PersistedSettingsShape = {
  speedMultiplier: z.unknown().transform(normalizeSpeedMultiplier),
  autoAdvance: z.unknown().transform(() => PERSISTED_SETTINGS_DEFAULTS.autoAdvance),
  pauseWhenUnfocused: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.pauseWhenUnfocused),
  inputLagMs: z.number().finite().int().min(0).max(1000).catch(PERSISTED_SETTINGS_DEFAULTS.inputLagMs),
  fightStartCountdown: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.fightStartCountdown),
  fightStartCountdownTicks: z
    .unknown()
    .transform((value) =>
      clampStoredInt(
        value,
        FIGHT_START_COUNTDOWN_TICKS_MIN,
        FIGHT_START_COUNTDOWN_TICKS_MAX,
        PERSISTED_SETTINGS_DEFAULTS.fightStartCountdownTicks,
      ),
    ),
  showCoordinates: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showCoordinates),
  showWaveTiles: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showWaveTiles),
  showDamageTiles: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showDamageTiles),
  showFireballDangerTiles: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showFireballDangerTiles),
  smoothTerrain: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.smoothTerrain),
  brightness: boundedNumber(0, 1.2, PERSISTED_SETTINGS_DEFAULTS.brightness),
  contrast: boundedNumber(0.5, 2, PERSISTED_SETTINGS_DEFAULTS.contrast),
  saturation: boundedNumber(0, 2, PERSISTED_SETTINGS_DEFAULTS.saturation),
  rendererType: z.unknown().transform(normalizeRendererType),
  mechanicsConfigPerEncounter: z.unknown().transform(parseMechanicsConfigPerEncounter),
  startingHpPerEncounter: z.unknown().transform(normalizeStartingHpPerEncounter),
  modifiersPerEncounter: z.unknown().transform(parseModifiersPerEncounter),
  modifierSettingsVersion: z.number().int().nonnegative().catch(0),
  logLevel: z.enum(['none', 'error', 'warn', 'info', 'debug', 'trace']).catch(PERSISTED_SETTINGS_DEFAULTS.logLevel),
  gamePanelPosition: z
    .unknown()
    .transform((value) => normalizePosition(value, PERSISTED_SETTINGS_DEFAULTS.gamePanelPosition)),
  minimapPosition: z
    .unknown()
    .transform((value) => normalizePosition(value, PERSISTED_SETTINGS_DEFAULTS.minimapPosition)),
  compactOrbsPosition: z
    .unknown()
    .transform((value) => normalizePosition(value, PERSISTED_SETTINGS_DEFAULTS.compactOrbsPosition)),
  infoboxPosition: z.unknown().transform(parseStoredPosition),
  infoboxPinTarget: z.enum(['hud', 'inventory', 'free']).catch(PERSISTED_SETTINGS_DEFAULTS.infoboxPinTarget),
  uiScale: z.unknown().transform(normalizeUiScale),
  stretchedModePluginEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.stretchedModePluginEnabled),
  autoOverlayScaleEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.autoOverlayScaleEnabled),
  showTickCounter: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showTickCounter),
  showTickCounterOverhead: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showTickCounterOverhead),
  tickCounterAbovePrayerIcon: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.tickCounterAbovePrayerIcon),
  showTickCounterInfobox: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showTickCounterInfobox),
  tickCounterMax: z
    .unknown()
    .transform((value) =>
      clampStoredInt(value, TICK_CYCLE_MIN, TICK_CYCLE_MAX, PERSISTED_SETTINGS_DEFAULTS.tickCounterMax),
    ),
  tickCounterFontSize: z
    .unknown()
    .transform((value) =>
      clampStoredInt(value, TICK_FONT_SIZE_MIN, TICK_FONT_SIZE_MAX, PERSISTED_SETTINGS_DEFAULTS.tickCounterFontSize),
    ),
  tickCounterColors: z.unknown().transform(normalizeTickCounterColors),
  tickCounterOffsetX: z
    .unknown()
    .transform((value) =>
      clampStoredInt(value, -TICK_OFFSET_LIMIT, TICK_OFFSET_LIMIT, PERSISTED_SETTINGS_DEFAULTS.tickCounterOffsetX),
    ),
  tickCounterOffsetY: z
    .unknown()
    .transform((value) =>
      clampStoredInt(value, -TICK_OFFSET_LIMIT, TICK_OFFSET_LIMIT, PERSISTED_SETTINGS_DEFAULTS.tickCounterOffsetY),
    ),
  showNpcClickbox: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showNpcClickbox),
  showTickTiming: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showTickTiming),
  showDetailedDps: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showDetailedDps),
  dpsOverlayShowDetails: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.dpsOverlayShowDetails),
  detailedDpsPosition: z.unknown().transform(parseStoredPosition),
  showSoundDebug: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showSoundDebug),
  showCameraDebug: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showCameraDebug),
  showModifierKeys: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showModifierKeys),
  attackStylePerCategory: z.unknown().transform(parseAttackStylePerCategory),
  showShortcutHints: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showShortcutHints),
  disabledShortcutHints: z.array(z.string()).catch(PERSISTED_SETTINGS_DEFAULTS.disabledShortcutHints),
  masterVolume: boundedNumber(0, 1, PERSISTED_SETTINGS_DEFAULTS.masterVolume),
  sfxVolume: boundedNumber(0, 1, PERSISTED_SETTINGS_DEFAULTS.sfxVolume),
  areaVolume: boundedNumber(0, 1, PERSISTED_SETTINGS_DEFAULTS.areaVolume),
  muteWhenUnfocused: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.muteWhenUnfocused),
  hideHardwareAccelWarning: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.hideHardwareAccelWarning),
  hideMobileWarning: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.hideMobileWarning),
  renderScaleHardware: boundedNumber(0.25, 1, PERSISTED_SETTINGS_DEFAULTS.renderScaleHardware),
  renderScaleSoftware: boundedNumber(0.25, 1, PERSISTED_SETTINGS_DEFAULTS.renderScaleSoftware),
  antiAliasing: z.enum(['auto', 'on', 'off']).catch(PERSISTED_SETTINGS_DEFAULTS.antiAliasing),
  showFps: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.showFps),
  fpsCap: FpsCapSchema.catch(144),
  cameraPluginEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.cameraPluginEnabled),
  cameraVerticalCamera: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.cameraVerticalCamera),
  cameraInvertYaw: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.cameraInvertYaw),
  cameraInvertPitch: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.cameraInvertPitch),
  cameraInnerZoomLevel: z.unknown().transform(normalizeInnerZoomLevel),
  cameraOuterZoomLimit: z
    .number()
    .finite()
    .int()
    .min(-400)
    .max(400)
    .catch(PERSISTED_SETTINGS_DEFAULTS.cameraOuterZoomLimit),
  cameraSpeed: positiveNumber(PERSISTED_SETTINGS_DEFAULTS.cameraSpeed),
  cameraDragSpeed: positiveNumber(PERSISTED_SETTINGS_DEFAULTS.cameraDragSpeed),
  cameraRightClickMovesCamera: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.cameraRightClickMovesCamera),
  cameraZoomIncrement: z.number().finite().int().positive().catch(PERSISTED_SETTINGS_DEFAULTS.cameraZoomIncrement),
  gameResolution: z.unknown().transform(normalizeGameResolution),
  clientLayoutMode: z
    .unknown()
    .transform((value) =>
      isClientLayoutMode(value) && value !== 'mobile' ? value : PERSISTED_SETTINGS_DEFAULTS.clientLayoutMode,
    ),
  fixedLayoutScale: z.unknown().transform(normalizeFixedLayoutScale),
  fixedLayoutIntegerScaling: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.fixedLayoutIntegerScaling),
  fixedChatboxVisible: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.fixedChatboxVisible),
  transparentChatbox: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.transparentChatbox),
  transparentSidePanel: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.transparentSidePanel),
  hotkeysCloseSidePanel: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.hotkeysCloseSidePanel),
  clickThroughTransparentChatbox: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.clickThroughTransparentChatbox),
  hasCompletedTutorial: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.hasCompletedTutorial),
  attackTimerMetronomeEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.attackTimerMetronomeEnabled),
  attackTimerMetronomeShowBar: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.attackTimerMetronomeShowBar),
  attackTimerMetronomeShowTicks: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.attackTimerMetronomeShowTicks),
  attackTimerMetronomeFontSize: z
    .unknown()
    .transform((value) =>
      clampStoredInt(
        value,
        TICK_FONT_SIZE_MIN,
        TICK_FONT_SIZE_MAX,
        PERSISTED_SETTINGS_DEFAULTS.attackTimerMetronomeFontSize,
      ),
    ),
  attackTimerMetronomeAbovePrayerIcon: z
    .boolean()
    .catch(PERSISTED_SETTINGS_DEFAULTS.attackTimerMetronomeAbovePrayerIcon),
  attackTimerMetronomeOffsetX: z
    .unknown()
    .transform((value) =>
      clampStoredInt(
        value,
        -TICK_OFFSET_LIMIT,
        TICK_OFFSET_LIMIT,
        PERSISTED_SETTINGS_DEFAULTS.attackTimerMetronomeOffsetX,
      ),
    ),
  attackTimerMetronomeOffsetY: z
    .unknown()
    .transform((value) =>
      clampStoredInt(
        value,
        -TICK_OFFSET_LIMIT,
        TICK_OFFSET_LIMIT,
        PERSISTED_SETTINGS_DEFAULTS.attackTimerMetronomeOffsetY,
      ),
    ),
  npcAttackTimerMetronomeEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.npcAttackTimerMetronomeEnabled),
  customMenuSwapsEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.customMenuSwapsEnabled),
  customMenuSwaps: z.string().catch(PERSISTED_SETTINGS_DEFAULTS.customMenuSwaps),
  instantInventoryEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.instantInventoryEnabled),
  instantPrayerEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.instantPrayerEnabled),
  prayerEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.prayerEnabled),
  prayerFlickOrbEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.prayerFlickOrbEnabled),
  prayerFlickAlwaysOn: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.prayerFlickAlwaysOn),
  prayerFlickEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.prayerFlickEnabled),
  tickAudioMetronomeEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.tickAudioMetronomeEnabled),
  tickAudioMetronomeTock: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.tickAudioMetronomeTock),
  tickAudioMetronomeVolume: boundedNumber(0, 1, PERSISTED_SETTINGS_DEFAULTS.tickAudioMetronomeVolume),
  tileGridEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.tileGridEnabled),
  tileGridColor: z
    .string()
    .regex(TICK_COLOR_PATTERN)
    .transform((color) => color.toLowerCase())
    .catch(PERSISTED_SETTINGS_DEFAULTS.tileGridColor),
  tileGridOpacity: z
    .number()
    .finite()
    .transform((value) => Math.min(1, Math.max(0, value)))
    .catch(PERSISTED_SETTINGS_DEFAULTS.tileGridOpacity),
  tileGridWidth: z.number().finite().transform(clampTileGridWidth).catch(PERSISTED_SETTINGS_DEFAULTS.tileGridWidth),
  prayerFlickPosition: z.unknown().transform(parseStoredPosition),
  statusBarsEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.statusBarsEnabled),
  statusBarsShowValues: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.statusBarsShowValues),
  entityHiderEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.entityHiderEnabled),
  entityHider: z.unknown().transform(parseEntityHiderOptions),
  tzhaarHpTrackerEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.tzhaarHpTrackerEnabled),
  tzhaarHpTracker: z.unknown().transform(parseTzhaarHpTrackerOptions),
  infernoAdditionsEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.infernoAdditionsEnabled),
  infernoAdditions: z.unknown().transform(parsePillarAdditionsOptions),
  colosseumAdditionsEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.colosseumAdditionsEnabled),
  colosseumAdditions: z.unknown().transform(parsePillarAdditionsOptions),
  zukSetTimerPosition: z.unknown().transform(parseStoredPosition),
  compactOrbsEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.compactOrbsEnabled),
  compactOrbsLayout: z.unknown().transform(normalizeCompactOrbsLayout),
  compactOrbsOrder: z.unknown().transform(normalizeCompactOrbsOrder),
  infoboxTextOutlineEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.infoboxTextOutlineEnabled),
  infoboxTextOutlineColor: z
    .string()
    .regex(TICK_COLOR_PATTERN)
    .transform((color) => color.toLowerCase())
    .catch(PERSISTED_SETTINGS_DEFAULTS.infoboxTextOutlineColor),
  touchLongPressMs: z
    .unknown()
    .transform((value) =>
      clampStoredStep(
        value,
        TOUCH_LONG_PRESS_MIN_MS,
        TOUCH_LONG_PRESS_MAX_MS,
        TOUCH_LONG_PRESS_STEP_MS,
        PERSISTED_SETTINGS_DEFAULTS.touchLongPressMs,
      ),
    ),
  touchMenuRowHeight: z
    .unknown()
    .transform((value) =>
      clampStoredStep(
        value,
        TOUCH_MENU_ROW_HEIGHT_MIN_PX,
        TOUCH_MENU_ROW_HEIGHT_MAX_PX,
        TOUCH_MENU_ROW_HEIGHT_STEP_PX,
        PERSISTED_SETTINGS_DEFAULTS.touchMenuRowHeight,
      ),
    ),
  touchHapticsEnabled: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.touchHapticsEnabled),
  mobileHotkeys: z.unknown().transform(normalizeMobileHotkeys),
  mobileHotkeysOpenOnLeft: z.boolean().catch(PERSISTED_SETTINGS_DEFAULTS.mobileHotkeysOpenOnLeft),
  // Only the slider's own stops; anything else is the default, as the native client resets a
  // mobile value below its range to 400.
  mobileInterfaceScaling: z
    .number()
    .refine(isOsmInterfaceScaling)
    .catch(PERSISTED_SETTINGS_DEFAULTS.mobileInterfaceScaling),
  mobileLayoutPlacement: z.unknown().transform(normalizeMobileLayoutPlacement),
  mobileOverrides: z.unknown().optional().transform(normalizeMobileOverrides),
} satisfies { [K in keyof PersistedSettings]-?: z.ZodType<PersistedSettings[K]> };

const PersistedSettingsSchema = z.object(PersistedSettingsShape);

/**
 * The one place a stored settings blob becomes trusted state.
 *
 * Every ingress uses it — first load and the popout
 * BroadcastChannel — because a path that skips it is a path where a value from another
 * build, another version, or a hand edit reaches the app unchecked.
 */
export function normalizeSettings(stored: unknown): PersistedSettings {
  const parsedSource = UnknownRecordSchema.safeParse(stored);
  const source = parsedSource.success ? parsedSource.data : {};
  // The stored version, not the merged one: the defaults carry the current version for a fresh start.
  const settings = migrateModifierSettings(
    PersistedSettingsSchema.parse({ ...PERSISTED_SETTINGS_DEFAULTS, ...source }),
    source.modifierSettingsVersion,
  );
  if (settings.mobileOverrides !== undefined) return settings;
  const { mobileOverrides: _, ...withoutEmptyOverrides } = settings;
  return withoutEmptyOverrides;
}

function load(): PersistedSettings {
  const stored = loadSetting<unknown>(STORAGE_KEY);
  return stored ? normalizeSettings(stored) : { ...PERSISTED_SETTINGS_DEFAULTS };
}

/**
 * Returns a snapshot of `settings` with mobile overrides folded in.
 *
 * Priority for each platform-overridable key, highest first:
 * 1. {@link FORCED_MOBILE_DEFAULTS} — invariants we never let a stored
 *    override win against.
 * 2. Explicit user override in `settings.mobileOverrides`
 * 3. {@link MOBILE_PLATFORM_DEFAULTS} fallback
 * 4. The base value already on `settings` (i.e. the desktop value)
 *
 * Pure and side-effect-free; safe to memoize on identity.
 */
export function applyMobileOverrides(settings: PersistedSettings): PersistedSettings {
  const overrides = settings.mobileOverrides;
  const merged: PersistedSettings = { ...settings };
  for (const key of PLATFORM_OVERRIDE_KEYS) {
    const forced = FORCED_MOBILE_DEFAULTS[key];
    if (forced !== undefined) {
      writeOverridableKey(merged, key, forced);
      continue;
    }
    const explicit = overrides?.[key];
    if (explicit !== undefined) {
      writeOverridableKey(merged, key, explicit);
      continue;
    }
    const fallback = MOBILE_PLATFORM_DEFAULTS[key];
    if (fallback !== undefined) {
      writeOverridableKey(merged, key, fallback);
    }
  }
  return merged;
}

/**
 * Mobile invariants — platform-overridable keys whose value on a mobile
 * device is non-negotiable, even if the stored `mobileOverrides` blob has
 * a different value (sync from a desktop tab, or a hand-edited stored blob).
 *
 * Mobile always uses its own layout and fit resolution. Controls shows the layout as a
 * noninteractive value; desktop choices remain in the unmerged base record.
 */
const FORCED_MOBILE_DEFAULTS: PlatformOverrides = {
  gameResolution: MOBILE_PLATFORM_DEFAULTS.gameResolution,
  clientLayoutMode: MOBILE_PLATFORM_DEFAULTS.clientLayoutMode,
};

/**
 * Type-safe per-key writer that preserves the K-relation between key and
 * value across a `for…of` loop. Necessary because iterating a const tuple
 * widens K to the union, which loses the per-iteration assignability proof
 * for `target[key] = value`.
 */
function writeOverridableKey<K extends PlatformOverrideKey>(
  target: PlatformOverrides | PersistedSettings,
  key: K,
  value: PersistedSettings[K],
): void {
  (target as PersistedSettings)[key] = value;
}

export function usePersistedSettings() {
  const [settings, setSettings] = useState<PersistedSettings>(load);
  const isInitial = useRef(true);
  // Platform-bucket selection uses the strict mobile-DEVICE check, not the
  // narrow-viewport breakpoint. A laptop user shrinking the browser window
  // below 720px is still on a desktop — their stored desktop settings (custom
  // game resolution, panel positions, ui scale) must survive the resize.
  const isMobile = useIsMobileDevice();
  const settingsOriginRef = useRef<'local' | 'broadcast'>('local');
  const channelRef = useRef<BroadcastChannel | null>(null);

  // Persist the canonical (unmerged) shape so toggling between desktop and
  // mobile never destroys either bucket. The merge happens at READ time only.
  useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false;
      return;
    }
    const origin = settingsOriginRef.current;
    settingsOriginRef.current = 'local';
    const { autoAdvance: _, ...toSave } = settings;
    if (origin === 'broadcast') return;
    saveSetting(STORAGE_KEY, toSave);
    // No channel exists while persistence is namespaced (see below), so this is
    // already a no-op for the dev UI harness.
    channelRef.current?.postMessage({ type: 'settings-updated', settings: toSave });
  }, [settings]);

  // Live-sync settings between main window and popout(s).
  //
  // Skipped entirely while persistence is namespaced (the dev UI harness): a
  // broadcast carries the payload itself, so a scoped writer would otherwise
  // still push its settings into a real app tab, which would persist them under
  // its own unprefixed keys.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined' || isStorageNamespaced()) {
      return;
    }
    const channel = new BroadcastChannel(SETTINGS_BROADCAST_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent) => {
      const parsed = UnknownRecordSchema.safeParse(event.data);
      if (!parsed.success || parsed.data.type !== 'settings-updated' || parsed.data.settings === undefined) return;
      settingsOriginRef.current = 'broadcast';
      // Through the same normalizer as a stored blob: a tab on another app version can
      // broadcast any shape, and a separate list of normalizers here would drift from it.
      setSettings(normalizeSettings(parsed.data.settings));
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, []);

  // On mobile devices we expose the merged view so consumers keep reading
  // flat fields without knowing about overrides. Memoized so referential
  // equality holds when neither platform nor source object changed.
  const effectiveSettings = useMemo(
    () => applyLayoutPlacement(isMobile ? applyMobileOverrides(settings) : settings),
    [isMobile, settings],
  );

  // The touch gestures run outside any one React subtree, so they read a mirror (see
  // touchPrefs). Layout effect, so a changed value is in place before the next touch.
  const { touchLongPressMs, touchMenuRowHeight, touchHapticsEnabled } = effectiveSettings;
  useLayoutEffect(() => {
    setTouchPrefs({
      longPressMs: touchLongPressMs,
      menuRowHeight: touchMenuRowHeight,
      hapticsEnabled: touchHapticsEnabled,
    });
  }, [touchLongPressMs, touchMenuRowHeight, touchHapticsEnabled]);

  const update = useCallback<UpdateSettingFn>(
    (key, value) => {
      settingsOriginRef.current = 'local';
      setSettings((prev) => applyUpdate(prev, key, value, isMobile));
    },
    [isMobile],
  );

  return [effectiveSettings, update] as const;
}

type UpdateSettingFn = <K extends keyof PersistedSettings>(key: K, value: PersistedSettings[K]) => void;

/**
 * Routes a settings write to the base record (desktop, or shared settings on mobile), the
 * `mobileOverrides` bucket (platform-overridable settings on a mobile device), or the Mobile
 * layout's placement bucket (an overlay moved while the Mobile layout is on screen, on any
 * device).
 *
 * Exported for tests; the hook is the only production caller.
 */
export function applyUpdate<K extends keyof PersistedSettings>(
  prev: PersistedSettings,
  key: K,
  value: PersistedSettings[K],
  isMobile: boolean,
): PersistedSettings {
  if (key === 'clientLayoutMode' && (isMobile || value === 'mobile')) return prev;
  if (isMobileLayoutPlacementKey(key)) {
    const layout = (isMobile ? applyMobileOverrides(prev) : prev).clientLayoutMode;
    if (layout === 'mobile') {
      const field = MOBILE_LAYOUT_PLACEMENT_KEYS[key];
      const { [field]: _previous, ...rest } = prev.mobileLayoutPlacement;
      const position = value as UIPosition | null;
      return { ...prev, mobileLayoutPlacement: position ? { ...rest, [field]: position } : rest };
    }
  }
  if (!isMobile || !isPlatformOverrideKey(key)) {
    return { ...prev, [key]: value };
  }
  // The runtime guard above narrows `key` (the variable) to a
  // PlatformOverrideKey, but TypeScript can't propagate that narrowing into
  // the K generic in our outer signature. The single localized assertion
  // below is sound by construction: `key ∈ PLATFORM_OVERRIDE_KEYS` and
  // `value` is `PersistedSettings[K]`, which is exactly what
  // `PlatformOverrides[K & PlatformOverrideKey]` expects.
  const nextOverrides = {
    ...(prev.mobileOverrides ?? {}),
    [key]: value,
  } as PlatformOverrides;
  return { ...prev, mobileOverrides: nextOverrides };
}
