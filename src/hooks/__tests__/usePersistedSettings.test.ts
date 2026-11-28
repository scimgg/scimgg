// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOUCH_PREFS, getTouchPrefs, setTouchPrefs } from '../../input/touchPrefs';
import { INNER_ZOOM_LEVEL_MAX, INNER_ZOOM_LEVEL_MIN } from '../../render/projections/Projection3D';
import { mergeMechanicsConfig, PLAYER_MECHANICS_KEY } from '../../types/simulation';
import { resetDeviceModeForTests, setDeviceMode } from '../../util/deviceMode';
import { setStorageNamespace } from '../../util/storage';
import {
  applyMobileOverrides,
  applyUpdate,
  infoboxPinTargetUnavailableReason,
  MOBILE_PLATFORM_DEFAULTS,
  normalizeFixedLayoutScale,
  normalizeInnerZoomLevel,
  normalizeMobileHotkeys,
  normalizeMobileOverrides,
  normalizeSettings,
  normalizeTickCounterColors,
  PERSISTED_SETTINGS_DEFAULTS,
  type PersistedSettings,
  PLATFORM_OVERRIDE_KEYS,
  parseStoredPosition,
  resolveAntialias,
  resolveInfoboxPinTarget,
  resolveRequestedFrameSize,
  usePersistedSettings,
} from '../usePersistedSettings';

const SETTINGS_KEY = 'osrs-yama-settings';

describe('Anti-aliasing preference', () => {
  afterEach(() => localStorage.clear());

  it.each([undefined, null, true, 'invalid'])('defaults absent or invalid preference %s to auto', (antiAliasing) => {
    expect(normalizeSettings({ antiAliasing }).antiAliasing).toBe('auto');
  });

  it.each(['auto', 'on', 'off'] as const)('persists %s and restores it on remount', (antiAliasing) => {
    const first = renderHook(() => usePersistedSettings());
    act(() => first.result.current[1]('antiAliasing', antiAliasing));
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}').antiAliasing).toBe(antiAliasing);
    first.unmount();
    const second = renderHook(() => usePersistedSettings());
    expect(second.result.current[0].antiAliasing).toBe(antiAliasing);
    second.unmount();
  });

  it.each([
    ['auto', 'software', false],
    ['auto', 'hardware', true],
    ['auto', 'no-webgl2', true],
    ['on', 'software', true],
    ['on', 'hardware', true],
    ['off', 'software', false],
    ['off', 'hardware', false],
  ] as const)('resolves %s on %s to %s', (preference, status, expected) => {
    expect(resolveAntialias(preference, status)).toBe(expected);
  });

  describe('on iPhone and iPad', () => {
    const device = (userAgent: string, maxTouchPoints: number) => ({ userAgent, maxTouchPoints }) as Navigator;
    const IPHONE = device(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
      5,
    );
    const IPAD = device('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 5);
    const MAC_UA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    const IPADOS = device(MAC_UA, 5);
    const MAC = device(MAC_UA, 0);
    const ANDROID = device(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
      5,
    );
    const WINDOWS = device(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      0,
    );

    afterEach(() => vi.restoreAllMocks());

    it.each([
      ['iPhone', IPHONE, false],
      ['iPad', IPAD, false],
      ['iPadOS posing as a Mac', IPADOS, false],
      ['Android phone', ANDROID, true],
      ['Mac', MAC, true],
      ['Windows desktop', WINDOWS, true],
    ] as const)('resolves the Auto default on %s with hardware acceleration to %s', (_name, nav, expected) => {
      expect(PERSISTED_SETTINGS_DEFAULTS.antiAliasing).toBe('auto');
      expect(resolveAntialias('auto', 'hardware', nav)).toBe(expected);
    });

    it.each([IPHONE, IPAD, IPADOS])('lets an explicit On win on Apple touch devices', (nav) => {
      expect(resolveAntialias('on', 'hardware', nav)).toBe(true);
    });

    it.each([ANDROID, MAC, WINDOWS])('lets an explicit Off win everywhere else', (nav) => {
      expect(resolveAntialias('off', 'hardware', nav)).toBe(false);
    });

    it('applies a stored preference over the iOS default after a reload', () => {
      const first = renderHook(() => usePersistedSettings());
      act(() => first.result.current[1]('antiAliasing', 'on'));
      first.unmount();
      const second = renderHook(() => usePersistedSettings());
      expect(resolveAntialias(second.result.current[0].antiAliasing, 'hardware', IPHONE)).toBe(true);
      second.unmount();
    });

    it("reads the browser's own navigator by default", () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE.userAgent);
      expect(resolveAntialias('auto', 'hardware')).toBe(false);
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WINDOWS.userAgent);
      expect(resolveAntialias('auto', 'hardware')).toBe(true);
    });
  });
});

describe('Unread replay practice preferences', () => {
  afterEach(() => localStorage.clear());
  it('drops unread rewind and enable preferences at the untrusted boundary', () => {
    const settings = normalizeSettings({ replayPracticeRewindTicks: 25, replayPracticeEnabled: true });
    expect(settings).not.toHaveProperty('replayPracticeRewindTicks');
    expect(settings).not.toHaveProperty('replayPracticeEnabled');
  });
});

describe('Side panel preferences', () => {
  afterEach(() => localStorage.clear());
  it('preserves existing defaults for absent or invalid settings', () => {
    for (const raw of [{}, { transparentSidePanel: 'false', hotkeysCloseSidePanel: 1 }]) {
      expect(normalizeSettings(raw)).toMatchObject({ transparentSidePanel: true, hotkeysCloseSidePanel: false });
    }
  });

  it('retains explicit preferences through settings normalization', () => {
    expect(normalizeSettings({ transparentSidePanel: false, hotkeysCloseSidePanel: true })).toMatchObject({
      transparentSidePanel: false,
      hotkeysCloseSidePanel: true,
    });
  });

  it('persists both preferences and restores them on remount', () => {
    const first = renderHook(() => usePersistedSettings());
    act(() => {
      first.result.current[1]('transparentSidePanel', false);
      first.result.current[1]('hotkeysCloseSidePanel', true);
    });
    first.unmount();
    const second = renderHook(() => usePersistedSettings());
    expect(second.result.current[0]).toMatchObject({ transparentSidePanel: false, hotkeysCloseSidePanel: true });
  });

  it('shares the transparency preference across layout changes', () => {
    const { result } = renderHook(() => usePersistedSettings());
    act(() => result.current[1]('transparentSidePanel', false));
    for (const mode of ['classic', 'fixed', 'modern'] as const) {
      act(() => result.current[1]('clientLayoutMode', mode));
      expect(result.current[0].transparentSidePanel).toBe(false);
    }
  });
});

const MALFORMED_SETTINGS = {
  speedMultiplier: 7,
  autoAdvance: false,
  pauseWhenUnfocused: 'false',
  inputLagMs: null,
  fightStartCountdown: 'false',
  fightStartCountdownTicks: '3',
  showCoordinates: 'false',
  showWaveTiles: 'false',
  showDamageTiles: 'false',
  showFireballDangerTiles: 'false',
  smoothTerrain: 'false',
  brightness: null,
  contrast: null,
  saturation: null,
  rendererType: 'none',
  mechanicsConfigPerEncounter: [],
  startingHpPerEncounter: [],
  modifiersPerEncounter: [],
  logLevel: 'verbose',
  gamePanelPosition: { x: 'left', y: 0 },
  minimapPosition: { x: 'left', y: 0 },
  compactOrbsPosition: { x: 'left', y: 0 },
  infoboxPosition: { x: 'left', y: 0 },
  infoboxPinTarget: 'panel',
  uiScale: 'large',
  stretchedModePluginEnabled: 'false',
  autoOverlayScaleEnabled: 'no',
  showTickCounter: 'false',
  showTickCounterOverhead: 'false',
  tickCounterAbovePrayerIcon: 'false',
  showTickCounterInfobox: 'false',
  tickCounterMax: null,
  tickCounterFontSize: null,
  tickCounterColors: [],
  tickCounterOffsetX: null,
  tickCounterOffsetY: null,
  showNpcClickbox: 'false',
  showTickTiming: 'false',
  showDetailedDps: 'false',
  dpsOverlayShowDetails: 'false',
  detailedDpsPosition: { x: 'left', y: 0 },
  showSoundDebug: 'false',
  showCameraDebug: 'false',
  showModifierKeys: 'false',
  attackStylePerCategory: [],
  showShortcutHints: 'false',
  disabledShortcutHints: 'zoom',
  masterVolume: null,
  sfxVolume: null,
  areaVolume: null,
  muteWhenUnfocused: 'false',
  hideHardwareAccelWarning: 'false',
  hideMobileWarning: 'false',
  renderScaleHardware: '1',
  renderScaleSoftware: null,
  antiAliasing: 'invalid',
  showFps: 'false',
  fpsCap: 75,
  cameraPluginEnabled: 'false',
  cameraVerticalCamera: 'false',
  cameraInvertYaw: 'false',
  cameraInvertPitch: 'false',
  cameraInnerZoomLevel: null,
  cameraOuterZoomLimit: null,
  cameraSpeed: null,
  cameraDragSpeed: null,
  cameraRightClickMovesCamera: 'false',
  cameraZoomIncrement: null,
  gameResolution: [],
  clientLayoutMode: 'resizable',
  fixedLayoutScale: null,
  fixedLayoutIntegerScaling: 'true',
  fixedChatboxVisible: 'false',
  transparentChatbox: 'false',
  clickThroughTransparentChatbox: 'false',
  transparentSidePanel: 'false',
  hotkeysCloseSidePanel: 'true',
  hasCompletedTutorial: 'false',
  attackTimerMetronomeEnabled: 'false',
  attackTimerMetronomeShowBar: 'false',
  attackTimerMetronomeShowTicks: 'true',
  attackTimerMetronomeFontSize: null,
  attackTimerMetronomeAbovePrayerIcon: 'true',
  attackTimerMetronomeOffsetX: null,
  attackTimerMetronomeOffsetY: 'up',
  npcAttackTimerMetronomeEnabled: 'false',
  customMenuSwapsEnabled: 'false',
  customMenuSwaps: null,
  instantInventoryEnabled: 'false',
  instantPrayerEnabled: 'false',
  prayerEnabled: 'false',
  prayerFlickOrbEnabled: 'false',
  prayerFlickAlwaysOn: 'false',
  prayerFlickEnabled: 'false',
  tickAudioMetronomeEnabled: 'true',
  tickAudioMetronomeTock: 'true',
  tickAudioMetronomeVolume: 3,
  tileGridEnabled: 'true',
  tileGridColor: 'white',
  tileGridOpacity: '0.3',
  tileGridWidth: null,
  prayerFlickPosition: { x: 'left', y: 0 },
  statusBarsEnabled: 'false',
  statusBarsShowValues: 'false',
  entityHiderEnabled: 'true',
  entityHider: 'everything',
  tzhaarHpTrackerEnabled: 1,
  tzhaarHpTracker: { showHp: 'sideways', highlightStyle: 'hull', recolorMenu: 'no', hideDead: null },
  infernoAdditionsEnabled: 'on',
  infernoAdditions: {
    hidePillars: 1,
    pillarMarkerStyle: 'HULL',
    pillarTileColor: 'red',
    pillarTileOpacity: 2,
  },
  colosseumAdditionsEnabled: null,
  colosseumAdditions: 'pillars',
  zukSetTimerPosition: { x: 'left', y: 0 },
  compactOrbsEnabled: 'false',
  compactOrbsLayout: 'diagonal',
  compactOrbsOrder: ['hp'],
  infoboxTextOutlineEnabled: 'false',
  infoboxTextOutlineColor: 'black',
  touchLongPressMs: '300',
  touchMenuRowHeight: null,
  touchHapticsEnabled: 'false',
  mobileHotkeys: [6, 8],
  mobileHotkeysOpenOnLeft: 'true',
  mobileInterfaceScaling: '300',
  mobileLayoutPlacement: 'nowhere',
  mobileOverrides: null,
} satisfies { [K in keyof Required<PersistedSettings>]: unknown };

function writeSettings(value: unknown): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
}

function readPersistedSettings(): Record<string, unknown> {
  const raw = localStorage.getItem(SETTINGS_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

describe('usePersistedSettings exhaustive untrusted boundary', () => {
  beforeEach(() => {
    localStorage.clear();
    mockMobileDevice(false);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('has an independently defaulting parser for every persisted field', () => {
    expect(normalizeSettings(MALFORMED_SETTINGS)).toEqual(PERSISTED_SETTINGS_DEFAULTS);
    expect(normalizeSettings(PERSISTED_SETTINGS_DEFAULTS)).toEqual(PERSISTED_SETTINGS_DEFAULTS);
  });

  it('holds the touch settings to their stepped ranges, defaulting to the mobile client long tap', () => {
    expect(PERSISTED_SETTINGS_DEFAULTS).toMatchObject({
      touchLongPressMs: 300,
      touchMenuRowHeight: 28,
      touchHapticsEnabled: true,
    });
    expect(normalizeSettings({ touchLongPressMs: 20, touchMenuRowHeight: 99 })).toMatchObject({
      touchLongPressMs: 100,
      touchMenuRowHeight: 48,
    });
    // A slider writes whole steps; a hand edit between them lands on the nearest one.
    expect(normalizeSettings({ touchLongPressMs: 5000, touchMenuRowHeight: 31 })).toMatchObject({
      touchLongPressMs: 1000,
      touchMenuRowHeight: 32,
    });
    expect(normalizeSettings({ touchLongPressMs: 430, touchHapticsEnabled: false })).toMatchObject({
      touchLongPressMs: 450,
      touchHapticsEnabled: false,
    });
    expect(normalizeSettings({ touchLongPressMs: Number.NaN }).touchLongPressMs).toBe(300);
  });

  it('mirrors the touch settings to the gestures, which read them outside React', () => {
    const { result } = renderHook(() => usePersistedSettings());
    try {
      act(() => result.current[1]('touchLongPressMs', 600));
      act(() => result.current[1]('touchHapticsEnabled', false));
      expect(getTouchPrefs()).toEqual({ longPressMs: 600, menuRowHeight: 28, hapticsEnabled: false });
    } finally {
      setTouchPrefs(DEFAULT_TOUCH_PREFS);
    }
  });

  it('keeps Auto sizing on by default, apart from the plugin switch and shared across platforms', () => {
    expect(PERSISTED_SETTINGS_DEFAULTS.autoOverlayScaleEnabled).toBe(true);
    expect(normalizeSettings({}).autoOverlayScaleEnabled).toBe(true);
    expect(normalizeSettings({ autoOverlayScaleEnabled: false })).toMatchObject({
      autoOverlayScaleEnabled: false,
      stretchedModePluginEnabled: true,
    });
    expect(normalizeSettings({ autoOverlayScaleEnabled: 'off' }).autoOverlayScaleEnabled).toBe(true);
    expect(PLATFORM_OVERRIDE_KEYS).not.toContain('autoOverlayScaleEnabled');
  });

  it('defaults the Stretched Mode plugin switch on and keeps a stored boolean', () => {
    expect(PERSISTED_SETTINGS_DEFAULTS.stretchedModePluginEnabled).toBe(true);
    expect(normalizeSettings({}).stretchedModePluginEnabled).toBe(true);
    expect(normalizeSettings({ stretchedModePluginEnabled: false }).stretchedModePluginEnabled).toBe(false);
    expect(normalizeSettings({ stretchedModePluginEnabled: 'off' }).stretchedModePluginEnabled).toBe(true);
  });

  it('ships the Tile Grid off and clamps its stored style to the editable ranges', () => {
    expect(PERSISTED_SETTINGS_DEFAULTS).toMatchObject({
      tileGridEnabled: false,
      tileGridColor: '#ffffff',
      tileGridOpacity: 0.3,
      tileGridWidth: 1,
    });
    expect(
      normalizeSettings({ tileGridEnabled: true, tileGridColor: '#A0B1C2', tileGridOpacity: 0.55, tileGridWidth: 2.5 }),
    ).toMatchObject({ tileGridEnabled: true, tileGridColor: '#a0b1c2', tileGridOpacity: 0.55, tileGridWidth: 2.5 });
    expect(normalizeSettings({ tileGridOpacity: 4, tileGridWidth: 40 })).toMatchObject({
      tileGridOpacity: 1,
      tileGridWidth: 10,
    });
    expect(normalizeSettings({ tileGridOpacity: -1, tileGridWidth: 0.1 })).toMatchObject({
      tileGridOpacity: 0,
      tileGridWidth: 0.5,
    });
    expect(normalizeSettings({ tileGridColor: '#fff', tileGridOpacity: Number.NaN })).toMatchObject({
      tileGridColor: '#ffffff',
      tileGridOpacity: 0.3,
    });
  });

  it('round-trips the Tile Grid settings through storage', () => {
    const { result, unmount } = renderHook(() => usePersistedSettings());
    act(() => {
      result.current[1]('tileGridEnabled', true);
      result.current[1]('tileGridColor', '#123456');
      result.current[1]('tileGridOpacity', 0.6);
      result.current[1]('tileGridWidth', 3);
    });
    unmount();
    const remounted = renderHook(() => usePersistedSettings());
    expect(remounted.result.current[0]).toMatchObject({
      tileGridEnabled: true,
      tileGridColor: '#123456',
      tileGridOpacity: 0.6,
      tileGridWidth: 3,
    });
    remounted.unmount();
  });

  it('keeps the chosen sizes while the Stretched Mode plugin is off', () => {
    const { result, unmount } = renderHook(() => usePersistedSettings());
    act(() => result.current[1]('uiScale', 1.5));
    act(() => result.current[1]('stretchedModePluginEnabled', false));
    unmount();
    const remounted = renderHook(() => usePersistedSettings());
    expect(remounted.result.current[0]).toMatchObject({
      stretchedModePluginEnabled: false,
      uiScale: 1.5,
    });
    remounted.unmount();
  });

  it('drops malformed nested entries without discarding valid siblings', () => {
    expect(
      normalizeSettings({
        mechanicsConfigPerEncounter: {
          yama_p3: { infiniteHealth: true, mode: 'practice', infiniteSpecialAttack: 'yes', broken: null },
          invalid: [],
        },
        startingHpPerEncounter: { valid: 25, invalid: '25' },
        attackStylePerCategory: { melee: 2, negative: -1, fraction: 1.5, text: '2' },
      }),
    ).toMatchObject({
      mechanicsConfigPerEncounter: { yama_p3: { infiniteHealth: true, mode: 'practice' } },
      startingHpPerEncounter: { valid: 25 },
      attackStylePerCategory: { melee: 2 },
    });
  });

  it('keeps each saved modifier selection, an all-off one included, dropping what is not a tier', () => {
    expect(
      normalizeSettings({
        modifiersPerEncounter: {
          sol_heredit: { doom: 2, bees: 4, frailty: '1', blasphemy: 3 },
          all_off: {},
          broken: null,
          listed: [1],
        },
      }).modifiersPerEncounter,
    ).toEqual({ sol_heredit: { doom: 2, blasphemy: 3 }, all_off: {} });
  });

  it('persists modifier selections and reads them back', () => {
    const first = renderHook(() => usePersistedSettings());
    act(() => first.result.current[1]('modifiersPerEncounter', { sol_heredit: {} }));
    first.unmount();
    expect(readPersistedSettings().modifiersPerEncounter).toEqual({ sol_heredit: {} });
    const second = renderHook(() => usePersistedSettings());
    expect(second.result.current[0].modifiersPerEncounter).toEqual({ sol_heredit: {} });
    second.unmount();
  });

  it('drops string boolean mechanics without dropping encounter choices', () => {
    expect(
      normalizeSettings({
        mechanicsConfigPerEncounter: {
          yama_p3: {
            autoPrepot: 'false',
            waves: 'false',
            fireballs: 'false',
            yamaMageRange: 'false',
            yamaMelee: 'false',
            voidFlares: 'false',
            infiniteStamina: 'false',
            fireballStart: 'vertical',
          },
        },
      }).mechanicsConfigPerEncounter,
    ).toEqual({ yama_p3: { fireballStart: 'vertical' } });
  });

  it.each([undefined, false, true, 'true'])('parses the separate Zeal account unlock %s', (zealPrayer) => {
    const settings = normalizeSettings({
      mechanicsConfigPerEncounter: { [PLAYER_MECHANICS_KEY]: { upgradedPrayers: true, zealPrayer } },
    });
    expect(mergeMechanicsConfig(undefined, settings.mechanicsConfigPerEncounter[PLAYER_MECHANICS_KEY])).toMatchObject({
      upgradedPrayers: true,
      zealPrayer: zealPrayer === true,
    });
  });

  it('normalizes every field from initial local storage', () => {
    writeSettings(MALFORMED_SETTINGS);

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0]).toEqual(PERSISTED_SETTINGS_DEFAULTS);
  });

  it('normalizes every field received from another window', () => {
    let deliver: ((event: MessageEvent) => void) | null = null;
    class RecordingChannel {
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        deliver = handler;
      }
      postMessage(): void {}
      close(): void {}
    }
    vi.stubGlobal('BroadcastChannel', RecordingChannel);
    const { result } = renderHook(() => usePersistedSettings());

    act(() => {
      deliver?.(new MessageEvent('message', { data: { type: 'settings-updated', settings: MALFORMED_SETTINGS } }));
    });

    expect(result.current[0]).toEqual(PERSISTED_SETTINGS_DEFAULTS);
  });
});

describe('usePersistedSettings synchronization ownership', () => {
  let deliver: ((event: MessageEvent) => void) | null;
  let posted: unknown[];

  beforeEach(() => {
    localStorage.clear();
    mockMobileDevice(false);
    deliver = null;
    posted = [];
    class RecordingChannel {
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        deliver = handler;
      }
      postMessage(message: unknown): void {
        posted.push(message);
      }
      close(): void {}
    }
    vi.stubGlobal('BroadcastChannel', RecordingChannel);
    vi.useFakeTimers();
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('applies a cross-version broadcast without overwriting local storage', async () => {
    const localSettings = { showCoordinates: false, newerVersionPreference: 'keep-me' };
    writeSettings(localSettings);
    const { result } = renderHook(() => usePersistedSettings());

    act(() => {
      deliver?.(
        new MessageEvent('message', {
          data: {
            type: 'settings-updated',
            settings: { showCoordinates: true, senderOnlyPreference: 'not-runtime-state' },
          },
        }),
      );
    });
    await vi.runAllTimersAsync();

    expect(result.current[0].showCoordinates).toBe(true);
    expect(result.current[0]).not.toHaveProperty('senderOnlyPreference');
    expect(readPersistedSettings()).toEqual(localSettings);
    expect(posted).toEqual([]);
  });

  it('persists and broadcasts a local edit batched with a remote update', async () => {
    const { result } = renderHook(() => usePersistedSettings());
    act(() => {
      deliver?.(
        new MessageEvent('message', {
          data: { type: 'settings-updated', settings: { showCoordinates: true } },
        }),
      );
      result.current[1]('tileGridEnabled', true);
    });
    await vi.runAllTimersAsync();

    expect(readPersistedSettings()).toMatchObject({ showCoordinates: true, tileGridEnabled: true });
    expect(posted).toHaveLength(1);
  });
});

describe('usePersistedSettings starting hitpoints normalization', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it.each([null, [], 'ten'])('falls back to an empty record for the malformed container %p', (stored) => {
    writeSettings({ startingHpPerEncounter: stored });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].startingHpPerEncounter).toEqual({});
  });

  it('preserves valid numeric entries through storage and load', () => {
    writeSettings({ startingHpPerEncounter: { yama_p3_bloodied: 25, future_contract: 40 } });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].startingHpPerEncounter).toEqual({ yama_p3_bloodied: 25, future_contract: 40 });
  });

  it('drops unusable entries while preserving valid siblings', () => {
    writeSettings({
      startingHpPerEncounter: {
        valid: 25,
        nan: Number.NaN,
        zero: 0,
        negative: -1,
        text: '10',
        infinite: Number.POSITIVE_INFINITY,
      },
    });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].startingHpPerEncounter).toEqual({ valid: 25 });
  });

  it('floors a fractional stored value', () => {
    writeSettings({ startingHpPerEncounter: { yama_p3_bloodied: 25.9 } });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].startingHpPerEncounter).toEqual({ yama_p3_bloodied: 25 });
  });
});

describe('usePersistedSettings muteWhenUnfocused default', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('defaults muteWhenUnfocused to true on a fresh install', () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].muteWhenUnfocused).toBe(true);
  });

  it('defaults muteWhenUnfocused to true for stored settings missing the field', () => {
    writeSettings({
      masterVolume: 0.3,
      sfxVolume: 0.5,
      areaVolume: 0.2,
    });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].muteWhenUnfocused).toBe(true);
    expect(result.current[0].masterVolume).toBe(0.3);
    expect(result.current[0].sfxVolume).toBe(0.5);
  });

  it('preserves an explicit false value from stored settings', () => {
    writeSettings({ muteWhenUnfocused: false });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].muteWhenUnfocused).toBe(false);
  });
});

describe('usePersistedSettings pauseWhenUnfocused', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('enables focus pausing on a fresh install', () => {
    const { result } = renderHook(() => usePersistedSettings());
    expect(result.current[0].pauseWhenUnfocused).toBe(true);
  });

  it('enables focus pausing for existing settings without the field', () => {
    writeSettings({ speedMultiplier: 0.5, muteWhenUnfocused: false });
    const { result } = renderHook(() => usePersistedSettings());
    expect(result.current[0].pauseWhenUnfocused).toBe(true);
    expect(result.current[0].muteWhenUnfocused).toBe(false);
  });

  it.each([true, false])('retains the explicit choice %s across reloads', (enabled) => {
    const first = renderHook(() => usePersistedSettings());
    act(() => first.result.current[1]('pauseWhenUnfocused', enabled));
    first.unmount();

    const { result } = renderHook(() => usePersistedSettings());
    expect(result.current[0].pauseWhenUnfocused).toBe(enabled);
  });

  it.each([null, 'false', 0])('defaults malformed value %s to enabled', (value) => {
    expect(normalizeSettings({ pauseWhenUnfocused: value }).pauseWhenUnfocused).toBe(true);
  });
});

describe('usePersistedSettings fight start countdown', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('counts down three ticks on a fresh install and for stored settings without the field', () => {
    expect(normalizeSettings({}).fightStartCountdown).toBe(true);
    expect(normalizeSettings({}).fightStartCountdownTicks).toBe(3);
    writeSettings({ speedMultiplier: 0.5 });
    const { result } = renderHook(() => usePersistedSettings());
    expect(result.current[0].fightStartCountdown).toBe(true);
    expect(result.current[0].fightStartCountdownTicks).toBe(3);
  });

  it('retains the explicit choice across reloads', () => {
    const first = renderHook(() => usePersistedSettings());
    act(() => first.result.current[1]('fightStartCountdown', false));
    act(() => first.result.current[1]('fightStartCountdownTicks', 5));
    first.unmount();

    const { result } = renderHook(() => usePersistedSettings());
    expect(result.current[0].fightStartCountdown).toBe(false);
    expect(result.current[0].fightStartCountdownTicks).toBe(5);
  });

  it.each([
    [0, 1],
    [9, 5],
    [2.4, 2],
    [2.6, 3],
    ['4', 3],
    [null, 3],
    [Number.NaN, 3],
    [Number.POSITIVE_INFINITY, 3],
    [Number.NEGATIVE_INFINITY, 3],
  ])('reads a stored length of %s as %s whole ticks', (stored, expected) => {
    expect(normalizeSettings({ fightStartCountdownTicks: stored }).fightStartCountdownTicks).toBe(expected);
  });

  it.each([null, 'false', 0])('defaults a malformed toggle %s to on', (value) => {
    expect(normalizeSettings({ fightStartCountdown: value }).fightStartCountdown).toBe(true);
  });

  it.each([
    true,
    false,
    null,
    'true',
    1,
  ])('drops an unread countdown movement value (%s) without changing other choices', (value) => {
    const saved = { fightStartCountdownMovement: value, fightStartCountdown: false, fightStartCountdownTicks: 5 };
    expect(normalizeSettings(saved)).not.toHaveProperty('fightStartCountdownMovement');
    writeSettings(saved);
    const { result } = renderHook(() => usePersistedSettings());
    expect(result.current[0]).not.toHaveProperty('fightStartCountdownMovement');
    expect(result.current[0]).toMatchObject({ fightStartCountdown: false, fightStartCountdownTicks: 5 });
    act(() => result.current[1]('fightStartCountdownTicks', 4));
    expect(readPersistedSettings()).not.toHaveProperty('fightStartCountdownMovement');
    expect(readPersistedSettings()).toMatchObject({ fightStartCountdown: false, fightStartCountdownTicks: 4 });
  });

  it.each([3, 5])('ignores an unread seconds-only countdown key (%i) without changing other choices', (seconds) => {
    const saved = {
      fightStartCountdownSeconds: seconds,
      fightStartCountdown: false,
      speedMultiplier: 2,
      showCoordinates: true,
    };
    const settings = normalizeSettings(saved);
    expect(settings).toMatchObject({
      fightStartCountdownTicks: 3,
      fightStartCountdown: false,
      speedMultiplier: 2,
      showCoordinates: true,
    });
    expect(settings).not.toHaveProperty('fightStartCountdownSeconds');
    writeSettings(saved);
    const { result } = renderHook(() => usePersistedSettings());
    expect(result.current[0]).toMatchObject({
      fightStartCountdownTicks: 3,
      fightStartCountdown: false,
      speedMultiplier: 2,
      showCoordinates: true,
    });
  });
});

describe('usePersistedSettings Prayer plugin default', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('defaults prayerEnabled to true on a fresh install', () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].prayerEnabled).toBe(true);
  });

  it('switches the Prayer plugin on for stored blobs without the key', () => {
    // A stored blob can carry no prayerEnabled at all. Defaulting the Prayer
    // plugin on for such a blob is intended.
    writeSettings({ prayerFlickEnabled: true, masterVolume: 0.3 });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].prayerEnabled).toBe(true);
    expect(result.current[0].prayerFlickOrbEnabled).toBe(true);
    expect(result.current[0].prayerFlickEnabled).toBe(true);
    expect(result.current[0].masterVolume).toBe(0.3);
  });

  it('preserves an explicit false value from stored settings', () => {
    writeSettings({ prayerEnabled: false });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].prayerEnabled).toBe(false);
  });
});

describe('usePersistedSettings RuneLite camera defaults', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('defaults exposed Camera plugin settings to RuneLite values', () => {
    const { result } = renderHook(() => usePersistedSettings());

    // The plugin ships on; its individual settings still default to RuneLite values.
    expect(result.current[0].cameraPluginEnabled).toBe(true);
    expect(result.current[0].cameraVerticalCamera).toBe(false);
    expect(result.current[0].cameraInvertYaw).toBe(false);
    expect(result.current[0].cameraInvertPitch).toBe(false);
    // Both zoom limits rest at 0 = the game's own. Inner is only a number because 0
    // means "no expansion"; a non-zero default would silently expand every new install.
    expect(result.current[0].cameraInnerZoomLevel).toBe(0);
    expect(result.current[0].cameraOuterZoomLimit).toBe(0);
    expect(result.current[0].cameraSpeed).toBe(1);
    expect(result.current[0].cameraRightClickMovesCamera).toBe(false);
    expect(result.current[0].cameraZoomIncrement).toBe(25);
  });

  it('defaults instantPrayerEnabled to true on a fresh install', () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(PERSISTED_SETTINGS_DEFAULTS.instantPrayerEnabled).toBe(true);
    expect(result.current[0].instantPrayerEnabled).toBe(true);
  });

  it('defaults statusBarsEnabled to false on a fresh install', () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(PERSISTED_SETTINGS_DEFAULTS.statusBarsEnabled).toBe(false);
    expect(result.current[0].statusBarsEnabled).toBe(false);
  });

  it('keeps a stored statusBarsEnabled across a reload', () => {
    writeSettings({ statusBarsEnabled: true });
    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].statusBarsEnabled).toBe(true);
  });

  it('defaults statusBarsShowValues to true on a fresh install, while the plugin stays off', () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(PERSISTED_SETTINGS_DEFAULTS.statusBarsShowValues).toBe(true);
    expect(result.current[0].statusBarsShowValues).toBe(true);
    expect(PERSISTED_SETTINGS_DEFAULTS.statusBarsEnabled).toBe(false);
  });

  it('keeps a stored statusBarsShowValues=false across a reload', () => {
    writeSettings({ statusBarsShowValues: false });
    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].statusBarsShowValues).toBe(false);
  });

  it('ships Entity Hider, TzHaar HP Tracker and the Inferno and Colosseum Additions off, with their plugin option defaults', () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].entityHiderEnabled).toBe(false);
    expect(Object.values(result.current[0].entityHider).every((hidden) => hidden === false)).toBe(true);
    expect(result.current[0].tzhaarHpTrackerEnabled).toBe(false);
    expect(result.current[0].tzhaarHpTracker).toEqual({
      showHp: 'aboveHpBar',
      highlightStyle: 'none',
      dynamicColor: 'off',
      recolorMenu: true,
      hideDead: false,
    });
    const pillarDefaults = {
      hidePillars: false,
      markPillarTiles: true,
      pillarMarkerStyle: 'borderedTile',
      pillarTileColor: '#282828',
      pillarTileOpacity: 0.6,
    };
    expect(result.current[0].infernoAdditionsEnabled).toBe(false);
    expect(result.current[0].infernoAdditions).toEqual(pillarDefaults);
    expect(result.current[0].colosseumAdditionsEnabled).toBe(false);
    expect(result.current[0].colosseumAdditions).toEqual(pillarDefaults);
  });

  it('keeps stored plugin options key by key, defaulting any a stored blob lacks', () => {
    writeSettings({
      entityHiderEnabled: true,
      entityHider: { hideNpcs: true, hideProjectiles: 'yes' },
      tzhaarHpTrackerEnabled: true,
      tzhaarHpTracker: { showHp: 'bottom', hideDead: true },
      infernoAdditions: { markPillarTiles: false },
      colosseumAdditions: { hidePillars: true, pillarTileColor: '#FF0000' },
    });
    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].entityHiderEnabled).toBe(true);
    expect(result.current[0].entityHider).toEqual({ ...PERSISTED_SETTINGS_DEFAULTS.entityHider, hideNpcs: true });
    expect(result.current[0].tzhaarHpTracker).toEqual({
      ...PERSISTED_SETTINGS_DEFAULTS.tzhaarHpTracker,
      showHp: 'bottom',
      hideDead: true,
    });
    // Each arena's options are its own.
    expect(result.current[0].infernoAdditions).toEqual({
      ...PERSISTED_SETTINGS_DEFAULTS.infernoAdditions,
      markPillarTiles: false,
    });
    expect(result.current[0].colosseumAdditions).toEqual({
      ...PERSISTED_SETTINGS_DEFAULTS.colosseumAdditions,
      hidePillars: true,
      pillarTileColor: '#ff0000',
    });
  });

  it('defaults the detailed DPS debug overlay to off', () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(PERSISTED_SETTINGS_DEFAULTS.showDetailedDps).toBe(false);
    expect(result.current[0].showDetailedDps).toBe(false);
  });

  it('keeps the detailed DPS debug overlay enabled across a reload', () => {
    writeSettings({ showDetailedDps: true });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].showDetailedDps).toBe(true);
  });

  it('defaults the DPS Overlay Detailed DPS option to off', () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(PERSISTED_SETTINGS_DEFAULTS.dpsOverlayShowDetails).toBe(false);
    expect(result.current[0].dpsOverlayShowDetails).toBe(false);
  });

  it('keeps the Detailed DPS option enabled across a reload', () => {
    writeSettings({ dpsOverlayShowDetails: true });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].dpsOverlayShowDetails).toBe(true);
  });

  it('leaves Detailed DPS off for a stored profile without the option', () => {
    writeSettings({ showDetailedDps: true });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].showDetailedDps).toBe(true);
    expect(result.current[0].dpsOverlayShowDetails).toBe(false);
  });

  it('preserves stored RuneLite-compatible Camera plugin values', () => {
    writeSettings({
      cameraPluginEnabled: true,
      cameraVerticalCamera: true,
      cameraInvertYaw: true,
      cameraInvertPitch: true,
      cameraOuterZoomLimit: 400,
      cameraSpeed: 2.5,
      cameraRightClickMovesCamera: true,
      cameraZoomIncrement: 50,
    });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].cameraPluginEnabled).toBe(true);
    expect(result.current[0].cameraVerticalCamera).toBe(true);
    expect(result.current[0].cameraInvertYaw).toBe(true);
    expect(result.current[0].cameraInvertPitch).toBe(true);
    expect(result.current[0].cameraOuterZoomLimit).toBe(400);
    expect(result.current[0].cameraSpeed).toBe(2.5);
    expect(result.current[0].cameraRightClickMovesCamera).toBe(true);
    expect(result.current[0].cameraZoomIncrement).toBe(50);
  });
});

describe('usePersistedSettings overlay positions', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps a stored set timer position across a reload', () => {
    // Replay frames carry `panels.zukSetTimer` from this field, so a
    // profile that dragged the overlay must not be rewritten to null.
    const position = { x: 300, y: 90, anchorX: 'left', anchorY: 'top' } as const;
    writeSettings({ zukSetTimerPosition: position });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].zukSetTimerPosition).toEqual(position);
  });

  it('defaults the set timer position to null on a fresh install', () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].zukSetTimerPosition).toBeNull();
  });
});

describe('usePersistedSettings Zuk safe region mechanic', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('leaves the safe region mechanic unset on a fresh profile', () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].mechanicsConfigPerEncounter.inferno?.zukShieldSafeTiles).toBeUndefined();
  });

  it('keeps the Zuk safe region mechanic enabled across a reload', () => {
    writeSettings({ mechanicsConfigPerEncounter: { inferno: { zukShieldSafeTiles: true } } });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].mechanicsConfigPerEncounter.inferno?.zukShieldSafeTiles).toBe(true);
  });

  it('keeps Duke settings after the rename', () => {
    writeSettings({
      mechanicsConfigPerEncounter: {
        duke_practice: { dukePracticeStartPhase: 'enrage', dukePracticeAlwaysBile: true },
      },
      startingHpPerEncounter: { duke_practice: 80 },
      modifiersPerEncounter: { duke_practice: { test: 2 } },
    });

    const { result } = renderHook(() => usePersistedSettings());
    const [settings] = result.current;

    expect(settings.mechanicsConfigPerEncounter).toEqual({ duke: { dukeStartPhase: 'enrage', dukeAlwaysBile: true } });
    expect(settings.startingHpPerEncounter).toEqual({ duke: 80 });
    expect(settings.modifiersPerEncounter).toEqual({ duke: { test: 2 } });
  });

  it('moves the retired Zuk kind’s choices onto the Inferno, the Zuk choice winning a shared key', () => {
    writeSettings({
      mechanicsConfigPerEncounter: {
        zuk: { zukShieldSafeTiles: true, infiniteHealth: true },
        inferno: { infernoStartWave: '40', infiniteHealth: false },
        yama_p3: { fireballs: false },
      },
    });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].mechanicsConfigPerEncounter).toMatchObject({
      inferno: { zukShieldSafeTiles: true, infernoStartWave: '40', infiniteHealth: true },
      yama_p3: { fireballs: false },
    });
    expect(result.current[0].mechanicsConfigPerEncounter).not.toHaveProperty('zuk');
  });
});

describe('usePersistedSettings attack cooldown ticks', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('leaves the cooldown number off for new users', () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].attackTimerMetronomeEnabled).toBe(false);
    expect(result.current[0].attackTimerMetronomeShowTicks).toBe(false);
  });

  it('keeps existing Attack Timer Metronome users on the bar alone', () => {
    writeSettings({ attackTimerMetronomeEnabled: true, tickCounterFontSize: 30, tickCounterOffsetX: 5 });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0]).toMatchObject({
      attackTimerMetronomeEnabled: true,
      attackTimerMetronomeShowBar: true,
      attackTimerMetronomeShowTicks: false,
      tickCounterFontSize: 30,
      tickCounterOffsetX: 5,
    });
  });
});

describe('usePersistedSettings NPC attack timer metronome overlay', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('defaults the NPC attack timer metronome overlay to off', () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(PERSISTED_SETTINGS_DEFAULTS.npcAttackTimerMetronomeEnabled).toBe(false);
    expect(result.current[0].npcAttackTimerMetronomeEnabled).toBe(false);
  });

  it('keeps the NPC attack timer metronome overlay enabled across a reload', () => {
    writeSettings({ npcAttackTimerMetronomeEnabled: true });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].npcAttackTimerMetronomeEnabled).toBe(true);
  });
});

/**
 * Pretend the test is running on a mobile DEVICE (or not).
 *
 * `usePersistedSettings` switches the platform bucket on `useIsMobileDevice`
 * (see `isMobileDevice`), which reads the user agent, touch points and the
 * pointer media queries, so the helper sets all of them consistently.
 */
function mockMobileDevice(isMobile: boolean): void {
  // jsdom does not implement matchMedia, so define it directly.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: isMobile,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get: () =>
      isMobile
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  Object.defineProperty(navigator, 'maxTouchPoints', {
    configurable: true,
    get: () => (isMobile ? 5 : 0),
  });
}

describe('applyMobileOverrides (pure merge)', () => {
  it('returns the input unchanged when there are no overrides and no mobile defaults match', () => {
    const base: PersistedSettings = {
      ...PERSISTED_SETTINGS_DEFAULTS,
      masterVolume: 0.42,
    };
    const merged = applyMobileOverrides(base);
    expect(merged.masterVolume).toBe(0.42);
    // Placement is the layout's, not the device's: no device override touches it.
    expect(merged.gamePanelPosition).toEqual(base.gamePanelPosition);
    expect(merged.uiScale).toBe(MOBILE_PLATFORM_DEFAULTS.uiScale);
  });

  it('prefers explicit mobileOverrides over MOBILE_PLATFORM_DEFAULTS', () => {
    const base: PersistedSettings = {
      ...PERSISTED_SETTINGS_DEFAULTS,
      mobileOverrides: { uiScale: 1.5 },
    };
    const merged = applyMobileOverrides(base);
    expect(merged.uiScale).toBe(1.5);
  });

  it('forces gameResolution to fit-mode on mobile, even when an explicit mobileOverride says otherwise', () => {
    // Invariant: the resolution picker is hidden on mobile devices, so a
    // stored fixed gameResolution override (a hand edit or sync from a
    // desktop tab) would strand the user with a tiny
    // letterboxed canvas and no UI to escape it. The mobile invariant must
    // beat the explicit override.
    const base: PersistedSettings = {
      ...PERSISTED_SETTINGS_DEFAULTS,
      mobileOverrides: {
        gameResolution: { mode: 'fixed', width: 1920, height: 1080, presetId: 'hd-1080' },
      },
    };
    const merged = applyMobileOverrides(base);
    expect(merged.gameResolution).toEqual(MOBILE_PLATFORM_DEFAULTS.gameResolution);
    expect(merged.gameResolution.mode).toBe('fit');
  });

  it('forces the Mobile layout on mobile, even when an explicit mobileOverride says otherwise', () => {
    // Mobile mode displays its only layout as a static value; synced overrides cannot change it.
    const base: PersistedSettings = {
      ...PERSISTED_SETTINGS_DEFAULTS,
      clientLayoutMode: 'fixed',
      mobileOverrides: { clientLayoutMode: 'classic' },
    };
    expect(applyMobileOverrides(base).clientLayoutMode).toBe('mobile');
    // The stored desktop choice is left alone for when the user is back on desktop.
    expect(base.clientLayoutMode).toBe('fixed');
  });

  it('prefers MOBILE_PLATFORM_DEFAULTS over the desktop value when no override is set', () => {
    const base: PersistedSettings = {
      ...PERSISTED_SETTINGS_DEFAULTS,
      gamePanelPosition: { x: 240, y: 120, anchorX: 'right', anchorY: 'bottom' },
      uiScale: 1.25,
      cameraPluginEnabled: true,
    };
    const merged = applyMobileOverrides(base);
    expect(merged.gamePanelPosition).toEqual(base.gamePanelPosition);
    expect(merged.uiScale).toBe(MOBILE_PLATFORM_DEFAULTS.uiScale);
    expect(merged.cameraPluginEnabled).toBe(false);
  });

  it('falls through to the desktop value for keys with no MOBILE_PLATFORM_DEFAULTS entry', () => {
    const base: PersistedSettings = {
      ...PERSISTED_SETTINGS_DEFAULTS,
      cameraOuterZoomLimit: 8,
    };
    const merged = applyMobileOverrides(base);
    expect(merged.cameraOuterZoomLimit).toBe(8);
  });

  it('does not mutate the input object', () => {
    const base: PersistedSettings = {
      ...PERSISTED_SETTINGS_DEFAULTS,
      mobileOverrides: { uiScale: 0.7 },
    };
    const snapshot = JSON.stringify(base);
    applyMobileOverrides(base);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe('applyUpdate (write routing)', () => {
  it('writes to the base on desktop', () => {
    const next = applyUpdate(PERSISTED_SETTINGS_DEFAULTS, 'uiScale', 1.4, false);
    expect(next.uiScale).toBe(1.4);
    expect(next.mobileOverrides).toBeUndefined();
  });

  it('writes shared keys to the base on mobile', () => {
    const next = applyUpdate(PERSISTED_SETTINGS_DEFAULTS, 'masterVolume', 0.5, true);
    expect(next.masterVolume).toBe(0.5);
    expect(next.mobileOverrides).toBeUndefined();
  });

  it('routes platform-overridable keys into mobileOverrides on mobile', () => {
    const next = applyUpdate(PERSISTED_SETTINGS_DEFAULTS, 'uiScale', 1.4, true);
    // Base value is left alone so the desktop bucket survives.
    expect(next.uiScale).toBe(PERSISTED_SETTINGS_DEFAULTS.uiScale);
    expect(next.mobileOverrides).toEqual({ uiScale: 1.4 });
  });

  it('routes camera settings into mobileOverrides on mobile', () => {
    const seed: PersistedSettings = {
      ...PERSISTED_SETTINGS_DEFAULTS,
      cameraPluginEnabled: true,
      cameraOuterZoomLimit: 400,
    };

    const next = applyUpdate(seed, 'cameraOuterZoomLimit', -400, true);

    expect(next.cameraPluginEnabled).toBe(true);
    expect(next.cameraOuterZoomLimit).toBe(400);
    expect(next.mobileOverrides).toEqual({ cameraOuterZoomLimit: -400 });
  });

  it('routes right-click camera ownership into mobileOverrides on mobile', () => {
    const next = applyUpdate(PERSISTED_SETTINGS_DEFAULTS, 'cameraRightClickMovesCamera', true, true);

    expect(next.cameraRightClickMovesCamera).toBe(false);
    expect(next.mobileOverrides).toEqual({ cameraRightClickMovesCamera: true });
  });

  it('merges into existing mobileOverrides without dropping siblings', () => {
    const seed: PersistedSettings = {
      ...PERSISTED_SETTINGS_DEFAULTS,
      mobileOverrides: { uiScale: 0.9 },
    };
    const next = applyUpdate(seed, 'cameraSpeed', 2, true);
    expect(next.mobileOverrides).toEqual({ uiScale: 0.9, cameraSpeed: 2 });
  });

  it('every key in PLATFORM_OVERRIDE_KEYS is a real PersistedSettings field', () => {
    for (const key of PLATFORM_OVERRIDE_KEYS) {
      expect(key in PERSISTED_SETTINGS_DEFAULTS).toBe(true);
    }
  });
});

describe('parseStoredPosition', () => {
  it('returns null for null input', () => {
    expect(parseStoredPosition(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseStoredPosition(undefined)).toBeNull();
  });

  it('returns a valid UIPosition unchanged', () => {
    const position = { x: 12, y: 34, anchorX: 'left' as const, anchorY: 'top' as const };

    expect(parseStoredPosition(position)).toEqual(position);
  });

  // Null means "follow the computed default", which is the honest answer for a value that
  // is not a position. Pinning the strip to the top-left corner moved a widget the user
  // never moved, and wrote a coordinate the replay format's strict schema rejects.
  it('returns null for an object that is not a position', () => {
    expect(parseStoredPosition({ nope: 'junk' })).toBeNull();
    expect(parseStoredPosition({ x: 'left', y: 3 })).toBeNull();
    expect(parseStoredPosition({ x: Number.NaN, y: 0 })).toBeNull();
    expect(parseStoredPosition({ x: -20, y: -30 })).toBeNull();
    expect(parseStoredPosition('nope')).toBeNull();
  });
});

describe('infobox pin target layout gating', () => {
  it('rules out only inventory, and only under the fixed layout', () => {
    expect(infoboxPinTargetUnavailableReason('inventory', 'fixed')).toContain('Fixed');
    expect(infoboxPinTargetUnavailableReason('inventory', 'classic')).toBeNull();
    expect(infoboxPinTargetUnavailableReason('inventory', 'modern')).toBeNull();
    // The mobile side panel closes on a second tap of its tab, so there is not always one to pin above.
    expect(infoboxPinTargetUnavailableReason('inventory', 'mobile')).toContain('Mobile');
    for (const layout of ['fixed', 'classic', 'modern', 'mobile'] as const) {
      expect(infoboxPinTargetUnavailableReason('hud', layout)).toBeNull();
      expect(infoboxPinTargetUnavailableReason('free', layout)).toBeNull();
    }
  });

  it('falls a ruled-out target back to the Chatbox corner and leaves every other target alone', () => {
    expect(resolveInfoboxPinTarget('inventory', 'fixed')).toBe('hud');
    expect(resolveInfoboxPinTarget('inventory', 'modern')).toBe('inventory');
    expect(resolveInfoboxPinTarget('inventory', 'mobile')).toBe('hud');
    expect(resolveInfoboxPinTarget('free', 'fixed')).toBe('free');
    expect(resolveInfoboxPinTarget('hud', 'fixed')).toBe('hud');
  });

  // Settings grays a segment out from the reason and renders the resolved target as the live
  // one; if a reason could survive resolution the picker would gray the option it had just
  // marked active.
  it('never resolves to a target that is itself ruled out', () => {
    for (const layout of ['fixed', 'classic', 'modern', 'mobile'] as const) {
      for (const target of ['hud', 'inventory', 'free'] as const) {
        const resolved = resolveInfoboxPinTarget(target, layout);
        expect(infoboxPinTargetUnavailableReason(resolved, layout)).toBeNull();
      }
    }
  });
});

describe('usePersistedSettings infobox pin target', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("defaults infoboxPinTarget to 'inventory' on a fresh install", () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(PERSISTED_SETTINGS_DEFAULTS.infoboxPinTarget).toBe('inventory');
    expect(result.current[0].infoboxPinTarget).toBe('inventory');
  });

  it("defaults a stored blob without an infoboxPinTarget, or with an invalid one, to 'inventory'", () => {
    writeSettings({ uiScale: 1.5 });
    const absent = renderHook(() => usePersistedSettings());
    expect(absent.result.current[0].infoboxPinTarget).toBe('inventory');
    expect(absent.result.current[0].uiScale).toBe(1.5);
    absent.unmount();

    writeSettings({ infoboxPinTarget: 'bogus' });
    const invalid = renderHook(() => usePersistedSettings());
    expect(invalid.result.current[0].infoboxPinTarget).toBe('inventory');
  });

  it.each(['hud', 'inventory', 'free'] as const)('preserves a stored infoboxPinTarget of %s', (target) => {
    writeSettings({ infoboxPinTarget: target });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].infoboxPinTarget).toBe(target);
  });
});

describe('Mobile layout placement (chosen by the layout on screen, not the device)', () => {
  const DESKTOP_DPS = { x: 300, y: 40, anchorX: 'left', anchorY: 'top' } as const;
  const MOBILE_DPS = { x: 12, y: 90, anchorX: 'right', anchorY: 'top' } as const;

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    resetDeviceModeForTests();
    mockMobileDevice(false);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps desktop positions exactly, and never seeds Mobile with them', () => {
    mockMobileDevice(false);
    writeSettings({ clientLayoutMode: 'modern', detailedDpsPosition: DESKTOP_DPS, zukSetTimerPosition: null });

    const { result } = renderHook(() => usePersistedSettings());
    expect(result.current[0].detailedDpsPosition).toEqual(DESKTOP_DPS);

    act(() => setDeviceMode('mobile'));
    // Mobile computes its own default rather than reusing a desktop coordinate.
    expect(result.current[0].detailedDpsPosition).toBeNull();
    expect(readPersistedSettings().detailedDpsPosition).toEqual(DESKTOP_DPS);
  });

  it('writes a move in forced Mobile mode to the Mobile bucket, leaving desktop alone', () => {
    mockMobileDevice(false);
    writeSettings({ clientLayoutMode: 'modern', detailedDpsPosition: DESKTOP_DPS });
    setDeviceMode('mobile');

    const { result } = renderHook(() => usePersistedSettings());
    act(() => result.current[1]('detailedDpsPosition', MOBILE_DPS));

    expect(result.current[0].detailedDpsPosition).toEqual(MOBILE_DPS);
    const persisted = readPersistedSettings();
    expect(persisted.detailedDpsPosition).toEqual(DESKTOP_DPS);
    expect(persisted.mobileLayoutPlacement).toEqual({ detailedDps: MOBILE_DPS });

    act(() => setDeviceMode('desktop'));
    expect(result.current[0].detailedDpsPosition).toEqual(DESKTOP_DPS);
  });

  it('uses the same bucket on a phone, whose layout is always Mobile', () => {
    mockMobileDevice(true);
    writeSettings({ clientLayoutMode: 'modern', mobileLayoutPlacement: { prayerFlick: MOBILE_DPS } });

    const { result } = renderHook(() => usePersistedSettings());
    expect(result.current[0].clientLayoutMode).toBe('mobile');
    expect(result.current[0].prayerFlickPosition).toEqual(MOBILE_DPS);

    act(() => result.current[1]('zukSetTimerPosition', MOBILE_DPS));
    expect(readPersistedSettings().mobileLayoutPlacement).toEqual({ prayerFlick: MOBILE_DPS, zukSetTimer: MOBILE_DPS });
    expect(readPersistedSettings().mobileOverrides).toBeUndefined();
  });

  it('clears a Mobile position back to the computed default', () => {
    const prev = {
      ...PERSISTED_SETTINGS_DEFAULTS,
      clientLayoutMode: 'mobile' as const,
      mobileLayoutPlacement: { detailedDps: MOBILE_DPS },
    };

    expect(applyUpdate(prev, 'detailedDpsPosition', null, false).mobileLayoutPlacement).toEqual({});
  });

  it('keeps only concrete, parseable positions in the bucket', () => {
    expect(
      normalizeSettings({
        mobileLayoutPlacement: {
          detailedDps: MOBILE_DPS,
          prayerFlick: null,
          zukSetTimer: { x: 'a' },
          extra: MOBILE_DPS,
        },
      }).mobileLayoutPlacement,
    ).toEqual({ detailedDps: MOBILE_DPS });
    expect(normalizeSettings({ mobileLayoutPlacement: [1, 2] }).mobileLayoutPlacement).toEqual({});
  });
});

describe('usePersistedSettings mobile overrides (integration)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns the desktop bucket on a desktop viewport even when mobileOverrides exist', () => {
    mockMobileDevice(false);
    writeSettings({
      gamePanelPosition: { x: 240, y: 120, anchorX: 'right', anchorY: 'bottom' },
      mobileOverrides: { uiScale: 2 },
    });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].gamePanelPosition).toEqual({ x: 240, y: 120, anchorX: 'right', anchorY: 'bottom' });
    expect(result.current[0].uiScale).toBe(1);
  });

  it('uses MOBILE_PLATFORM_DEFAULTS on mobile when no override exists yet', () => {
    mockMobileDevice(true);
    writeSettings({
      gamePanelPosition: { x: 240, y: 120, anchorX: 'right', anchorY: 'bottom' },
      uiScale: 1.5,
      cameraPluginEnabled: true,
      showShortcutHints: true,
    });

    const { result } = renderHook(() => usePersistedSettings());

    // Unread in the Mobile layout, which pins the panel; left as the desktop value.
    expect(result.current[0].gamePanelPosition).toEqual({ x: 240, y: 120, anchorX: 'right', anchorY: 'bottom' });
    expect(result.current[0].uiScale).toBe(MOBILE_PLATFORM_DEFAULTS.uiScale);
    expect(result.current[0].cameraPluginEnabled).toBe(false);
    expect(result.current[0].showShortcutHints).toBe(false);
  });

  it('persists mobile writes into mobileOverrides without touching the desktop value', () => {
    mockMobileDevice(true);
    writeSettings({ uiScale: 1.25 });

    const { result } = renderHook(() => usePersistedSettings());

    act(() => {
      result.current[1]('uiScale', 1.5);
    });

    expect(result.current[0].uiScale).toBe(1.5);
    const persisted = readPersistedSettings();
    expect(persisted.uiScale).toBe(1.25);
    expect(persisted.mobileOverrides).toEqual({ uiScale: 1.5 });
  });

  it('routes shared writes to the base bucket even on mobile', () => {
    mockMobileDevice(true);
    const { result } = renderHook(() => usePersistedSettings());

    act(() => {
      result.current[1]('masterVolume', 0.42);
    });

    expect(result.current[0].masterVolume).toBe(0.42);
    const persisted = readPersistedSettings();
    expect(persisted.masterVolume).toBe(0.42);
    expect(persisted.mobileOverrides).toBeUndefined();
  });

  it('stored settings without mobileOverrides load identically', () => {
    mockMobileDevice(false);
    writeSettings({
      gamePanelPosition: { x: 200, y: 100, anchorX: 'right', anchorY: 'bottom' },
      masterVolume: 0.33,
    });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].gamePanelPosition).toEqual({ x: 200, y: 100, anchorX: 'right', anchorY: 'bottom' });
    expect(result.current[0].masterVolume).toBe(0.33);
    const persisted = readPersistedSettings();
    expect(persisted.mobileOverrides).toBeUndefined();
  });
});

describe('normalizeMobileOverrides (untrusted input parsing)', () => {
  it('returns undefined for null', () => {
    expect(normalizeMobileOverrides(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(normalizeMobileOverrides(undefined)).toBeUndefined();
  });

  it('returns undefined for a non-object primitive', () => {
    expect(normalizeMobileOverrides('not an object')).toBeUndefined();
    expect(normalizeMobileOverrides(42)).toBeUndefined();
    expect(normalizeMobileOverrides(true)).toBeUndefined();
  });

  it('returns undefined when the object has no override-bucket keys', () => {
    expect(normalizeMobileOverrides({})).toBeUndefined();
    // Keys that aren't in PLATFORM_OVERRIDE_KEYS are dropped, leaving an empty
    // result which should collapse to undefined so callers can treat "missing"
    // and "empty" identically.
    expect(normalizeMobileOverrides({ masterVolume: 0.5, speedMultiplier: 2 })).toBeUndefined();
  });

  it('preserves valid platform-override keys', () => {
    const result = normalizeMobileOverrides({
      uiScale: 1.5,
      cameraPluginEnabled: false,
      showShortcutHints: false,
    });
    expect(result).toEqual({
      uiScale: 1.5,
      cameraPluginEnabled: false,
      showShortcutHints: false,
    });
  });

  it('clamps a stored mobile scale below 100 percent', () => {
    expect(normalizeMobileOverrides({ uiScale: 0.85 })).toEqual({ uiScale: 1 });
  });

  it('drops keys that are not in PLATFORM_OVERRIDE_KEYS', () => {
    const result = normalizeMobileOverrides({
      uiScale: 1.5, // allowed
      masterVolume: 0.5, // NOT allowed — shared setting
      speedMultiplier: 2, // NOT allowed — shared setting
    });
    expect(result).toEqual({ uiScale: 1.5 });
    expect(result).not.toHaveProperty('masterVolume');
    expect(result).not.toHaveProperty('speedMultiplier');
  });

  it('drops per-device placement keys from stored mobile overrides', () => {
    // Placement belongs to the layout now, and a phone always draws Mobile, which pins every
    // one of these panels: no surface reads them any more.
    const result = normalizeMobileOverrides({
      uiScale: 1.5,
      gamePanelPosition: { x: 12, y: 8, anchorX: 'left', anchorY: 'top' },
      minimapPosition: { x: 4, y: 4, anchorX: 'right', anchorY: 'top' },
      compactOrbsPosition: { x: -12, y: 60 },
      infoboxPosition: null,
    });
    expect(result).toEqual({ uiScale: 1.5 });
  });

  it('skips keys whose value is undefined', () => {
    const result = normalizeMobileOverrides({
      uiScale: 1.5,
      cameraPluginEnabled: undefined,
    });
    expect(result).toEqual({ uiScale: 1.5 });
    expect(result).not.toHaveProperty('cameraPluginEnabled');
  });

  it('round-trips a mixed real-world payload', () => {
    const stored = {
      uiScale: 0.85,
      gamePanelPosition: { x: 8, y: 8, anchorX: 'right', anchorY: 'bottom' },
      minimapPosition: { x: 8, y: 8, anchorX: 'right', anchorY: 'top' },
      renderScaleHardware: 0.85,
      cameraPluginEnabled: false,
      cameraVerticalCamera: false,
      showShortcutHints: false,
      // Shared key that should be dropped:
      masterVolume: 0.42,
      // Typo / removed key that should be dropped:
      thisKeyDoesNotExist: 'junk',
    };
    const result = normalizeMobileOverrides(stored);
    // The two positions are per-device placement keys; see above.
    expect(result).toEqual({
      uiScale: 1,
      renderScaleHardware: 0.85,
      cameraPluginEnabled: false,
      cameraVerticalCamera: false,
      showShortcutHints: false,
    });
  });

  it('every PLATFORM_OVERRIDE_KEY is either preserved or intentionally filtered', () => {
    // Sanity check: the normalizer iterates PLATFORM_OVERRIDE_KEYS, so every
    // override-bucket key should round-trip when provided a valid value.
    // This catches a key added to the allow-list without a branch for it,
    // which would silently drop data.
    const probe: Record<string, unknown> = {};
    for (const key of PLATFORM_OVERRIDE_KEYS) {
      const defaultValue = PERSISTED_SETTINGS_DEFAULTS[key];
      probe[key] = defaultValue;
    }
    const result = normalizeMobileOverrides(probe);
    expect(result).toBeDefined();
    for (const key of PLATFORM_OVERRIDE_KEYS) {
      expect(result).toHaveProperty(key);
    }
  });

  it('lets invalid scalar overrides fall through to mobile defaults and desktop preferences', () => {
    const settings = normalizeSettings({
      ...PERSISTED_SETTINGS_DEFAULTS,
      cameraSpeed: 2,
      mobileOverrides: { renderScaleHardware: '1', cameraSpeed: null, showShortcutHints: 'true' },
    });
    expect(settings.mobileOverrides).toBeUndefined();
    expect(applyMobileOverrides(settings)).toMatchObject({
      renderScaleHardware: 0.85,
      cameraSpeed: 2,
      showShortcutHints: false,
    });
  });

  it('drops invalid transformed overrides instead of materializing their base defaults', () => {
    expect(
      normalizeMobileOverrides({
        infoboxPosition: { x: 'left', y: 0 },
        uiScale: 'large',
        rendererType: 'none',
        cameraInnerZoomLevel: null,
        gameResolution: [],
        clientLayoutMode: 'resizable',
      }),
    ).toBeUndefined();
  });
});

describe('usePersistedSettings Device Mode layout ownership', () => {
  let deviceDescriptors: {
    matchMedia: PropertyDescriptor | undefined;
    userAgent: PropertyDescriptor | undefined;
    maxTouchPoints: PropertyDescriptor | undefined;
  };

  beforeEach(() => {
    deviceDescriptors = {
      matchMedia: Object.getOwnPropertyDescriptor(window, 'matchMedia'),
      userAgent: Object.getOwnPropertyDescriptor(navigator, 'userAgent'),
      maxTouchPoints: Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints'),
    };
    localStorage.clear();
    resetDeviceModeForTests();
    mockMobileDevice(false);
  });

  afterEach(() => {
    localStorage.clear();
    resetDeviceModeForTests();
    for (const key of ['userAgent', 'maxTouchPoints'] as const) {
      const descriptor = deviceDescriptors[key];
      if (descriptor) Object.defineProperty(navigator, key, descriptor);
      else Reflect.deleteProperty(navigator, key);
    }
    if (deviceDescriptors.matchMedia) Object.defineProperty(window, 'matchMedia', deviceDescriptors.matchMedia);
    else Reflect.deleteProperty(window, 'matchMedia');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    'fixed',
    'classic',
    'modern',
  ] as const)('restores %s and its desktop settings after Mobile, ignoring layout writes', (mode) => {
    const gameResolution = { mode: 'fixed', width: 1280, height: 720, presetId: 'hd-720' } as const;
    const desktopPosition = { x: 300, y: 40, anchorX: 'left', anchorY: 'top' } as const;
    const mobilePosition = { x: 12, y: 90, anchorX: 'right', anchorY: 'top' } as const;
    writeSettings({
      clientLayoutMode: mode,
      gameResolution,
      fixedLayoutScale: 1.5,
      detailedDpsPosition: desktopPosition,
      mobileLayoutPlacement: { detailedDps: mobilePosition },
      mobileOverrides: { clientLayoutMode: 'classic' },
    });
    setDeviceMode('desktop');
    const { result } = renderHook(() => usePersistedSettings());
    act(() => result.current[1]('clientLayoutMode', 'mobile'));
    expect(result.current[0].clientLayoutMode).toBe(mode);
    act(() => setDeviceMode('mobile'));
    expect(result.current[0]).toMatchObject({
      clientLayoutMode: 'mobile',
      gameResolution: MOBILE_PLATFORM_DEFAULTS.gameResolution,
      detailedDpsPosition: mobilePosition,
    });
    act(() => {
      result.current[1]('clientLayoutMode', 'fixed');
      result.current[1]('clientLayoutMode', 'mobile');
      result.current[1]('showCoordinates', true);
    });
    expect(readPersistedSettings()).toMatchObject({
      clientLayoutMode: mode,
      gameResolution,
      fixedLayoutScale: 1.5,
      detailedDpsPosition: desktopPosition,
      mobileLayoutPlacement: { detailedDps: mobilePosition },
      mobileOverrides: { clientLayoutMode: 'classic' },
    });
    act(() => setDeviceMode('desktop'));
    expect(result.current[0]).toMatchObject({
      clientLayoutMode: mode,
      gameResolution,
      fixedLayoutScale: 1.5,
      detailedDpsPosition: desktopPosition,
    });
  });

  it.each([false, true])('Auto follows effective device detection (%s) and remains reversible', (mobile) => {
    mockMobileDevice(mobile);
    writeSettings({ clientLayoutMode: 'classic' });
    const { result } = renderHook(() => usePersistedSettings());
    expect(result.current[0].clientLayoutMode).toBe(mobile ? 'mobile' : 'classic');
    act(() => setDeviceMode(mobile ? 'desktop' : 'mobile'));
    expect(result.current[0].clientLayoutMode).toBe(mobile ? 'classic' : 'mobile');
    act(() => setDeviceMode('auto'));
    expect(result.current[0].clientLayoutMode).toBe(mobile ? 'mobile' : 'classic');
  });

  it.each([
    'normalize',
    'storage',
    'broadcast',
  ] as const)('normalizes a stored base Mobile through %s without inferring Device Mode', (source) => {
    const saved = { clientLayoutMode: 'mobile' };
    expect(normalizeSettings(saved).clientLayoutMode).toBe('modern');
    let deliver: ((event: MessageEvent) => void) | null = null;
    class RecordingChannel {
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        deliver = handler;
      }
      postMessage(): void {}
      close(): void {}
    }
    vi.stubGlobal('BroadcastChannel', RecordingChannel);
    if (source === 'storage') writeSettings(saved);
    const { result } = renderHook(() => usePersistedSettings());
    if (source === 'broadcast') {
      act(() => deliver?.(new MessageEvent('message', { data: { type: 'settings-updated', settings: saved } })));
    }
    expect(result.current[0].clientLayoutMode).toBe('modern');
    expect(localStorage.getItem('osrs-yama-device-mode')).toBeNull();
    act(() => setDeviceMode('mobile'));
    expect(result.current[0].clientLayoutMode).toBe('mobile');
    act(() => setDeviceMode('desktop'));
    expect(result.current[0].clientLayoutMode).toBe('modern');
  });

  it('rejects layout writes before touching either settings bucket', () => {
    const settings = { ...PERSISTED_SETTINGS_DEFAULTS, clientLayoutMode: 'classic' as const };
    expect(applyUpdate(settings, 'clientLayoutMode', 'mobile', false)).toBe(settings);
    expect(applyUpdate(settings, 'clientLayoutMode', 'modern', true)).toBe(settings);
    expect(applyUpdate(settings, 'clientLayoutMode', 'mobile', true)).toBe(settings);
  });
});

describe('usePersistedSettings clientLayoutMode normalization', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reads a blob without a layout mode as modern', () => {
    writeSettings({ showCoordinates: true });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].clientLayoutMode).toBe('modern');
  });

  it.each(['fixed', 'classic', 'modern'] as const)('round-trips a stored %s layout', (mode) => {
    writeSettings({ clientLayoutMode: mode });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].clientLayoutMode).toBe(mode);
  });

  it.each([
    ['mobile'],
    ['resizable'],
    [''],
    [null],
    [7],
    [{}],
  ])('falls back to modern for the unsupported or junk value %s', (stored) => {
    writeSettings({ clientLayoutMode: stored });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].clientLayoutMode).toBe('modern');
  });

  it('leaves a stored gameResolution untouched while fixed is selected', () => {
    // Fixed ignores the resolution rather than overwriting it, so switching back
    // to a resizable layout has to return the user's own choice intact.
    const gameResolution = { mode: 'fixed' as const, width: 1280, height: 720, presetId: 'hd-720' as const };
    writeSettings({ clientLayoutMode: 'fixed', gameResolution });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].gameResolution).toEqual(gameResolution);
  });
});

describe('fixedLayoutScale', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reads a blob without a fixed-layout scale as fit', () => {
    writeSettings({ clientLayoutMode: 'fixed' });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].fixedLayoutScale).toBe('fit');
  });

  it('round-trips Stretch to Window', () => {
    writeSettings({ fixedLayoutScale: 'stretch' });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].fixedLayoutScale).toBe('stretch');
    expect(normalizeFixedLayoutScale('stretch')).toBe('stretch');
  });

  it.each([1, 1.5, 2, 3.25])('round-trips a stored multiple of %s', (scale) => {
    writeSettings({ fixedLayoutScale: scale });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].fixedLayoutScale).toBe(scale);
  });

  it.each([
    ['fit'],
    ['2x'],
    [''],
    ['Stretch'],
    ['stretched'],
    [null],
    [{}],
    [Number.NaN],
  ])('falls back to fit for the junk value %s', (stored) => {
    writeSettings({ fixedLayoutScale: stored });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].fixedLayoutScale).toBe('fit');
  });

  it('clamps an out-of-range stored multiple into the allowed bounds', () => {
    expect(normalizeFixedLayoutScale(99)).toBe(6);
    expect(normalizeFixedLayoutScale(-3)).toBe(0.5);
  });

  it('defaults Integer scaling off, round-trips it, and drops a non-boolean', () => {
    expect(PERSISTED_SETTINGS_DEFAULTS.fixedLayoutIntegerScaling).toBe(false);

    writeSettings({ fixedLayoutIntegerScaling: true });
    const stored = renderHook(() => usePersistedSettings());
    expect(stored.result.current[0].fixedLayoutIntegerScaling).toBe(true);
    stored.unmount();

    writeSettings({ fixedLayoutIntegerScaling: 'true' });
    const junk = renderHook(() => usePersistedSettings());
    expect(junk.result.current[0].fixedLayoutIntegerScaling).toBe(false);
  });
});

describe('tick counter colors', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  // Restored, not merely reset: per-file isolation hides a leaked blob until two
  // suites share a worker, where it surfaces as an order-dependent failure.
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('defaults to no overrides, so every tick keeps the gradient', () => {
    expect(PERSISTED_SETTINGS_DEFAULTS.tickCounterColors).toEqual({});
  });

  it('round-trips a per-tick override through storage', () => {
    writeSettings({ tickCounterColors: { '1': '#FF00AA', '4': '#00ff00' } });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].tickCounterColors).toEqual({ '1': '#ff00aa', '4': '#00ff00' });
  });

  // A malformed value reaches a CSS `color` assignment, where it is ignored and
  // the tick inherits whatever is around it instead of taking its own color.
  it.each([
    ['a non-object blob', 'nope'],
    ['an array', ['#ffffff']],
    ['null', null],
  ])('drops %s entirely', (_label, stored) => {
    expect(normalizeTickCounterColors(stored)).toEqual({});
  });

  it.each([
    ['a shorthand hex', { '1': '#fff' }],
    ['a named color', { '1': 'red' }],
    ['an rgb() function', { '1': 'rgb(255,0,0)' }],
    ['a non-numeric tick key', { first: '#ffffff' }],
    ['a non-string value', { '1': 16711680 }],
    // No cycle length can produce these, so they would sit in the map marking
    // the row modified with no chip able to clear them.
    ['a zero tick key', { '0': '#ffffff' }],
    ['a zero-padded tick key', { '01': '#ffffff' }],
    ['a tick key past the longest cycle', { '999': '#ffffff' }],
  ])('drops %s while keeping the valid entries beside it', (_label, stored) => {
    expect(normalizeTickCounterColors({ ...stored, '2': '#123abc' })).toEqual({ '2': '#123abc' });
  });

  it('keeps overrides above the current cycle length so lengthening it restores them', () => {
    expect(normalizeTickCounterColors({ '20': '#123abc' })).toEqual({ '20': '#123abc' });
  });

  // JSON.parse turns an out-of-range literal into Infinity, which reaches
  // tickCycle's Array.from length. JSON.stringify cannot round-trip it (it emits
  // null), so this vector only exists via a raw hand-edited string.
  it('rejects an overflowing stored max that JSON.parse widened to Infinity', () => {
    localStorage.setItem(SETTINGS_KEY, '{"tickCounterMax":1e309}');

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].tickCounterMax).toBe(PERSISTED_SETTINGS_DEFAULTS.tickCounterMax);
  });

  // A stored blob is hand-editable, so the panel's own min/max never sees these.
  it.each([
    ['tickCounterMax', 0, 'tickCounterMax', 2],
    ['tickCounterFontSize', -5, 'tickCounterFontSize', 8],
    ['tickCounterFontSize', 900, 'tickCounterFontSize', 72],
    ['attackTimerMetronomeFontSize', 2, 'attackTimerMetronomeFontSize', 8],
    ['attackTimerMetronomeOffsetX', 5000, 'attackTimerMetronomeOffsetX', 200],
    ['tickCounterOffsetX', 5000, 'tickCounterOffsetX', 200],
    ['tickCounterOffsetY', -5000, 'tickCounterOffsetY', -200],
  ])('clamps a stored %s of %s into range', (key, stored, readKey, expected) => {
    writeSettings({ [key]: stored });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0][readKey as 'tickCounterMax']).toBe(expected);
  });

  it.each([['nonsense'], [null], [Number.NaN]])('falls back to the default for an unusable max of %s', (stored) => {
    writeSettings({ tickCounterMax: stored });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].tickCounterMax).toBe(PERSISTED_SETTINGS_DEFAULTS.tickCounterMax);
  });

  it('treats a non-boolean stored placement as off rather than truthy', () => {
    writeSettings({ tickCounterAbovePrayerIcon: 'false' });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].tickCounterAbovePrayerIcon).toBe(false);
  });
});

describe('camera inner zoom level', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it.each([INNER_ZOOM_LEVEL_MIN, 4, INNER_ZOOM_LEVEL_MAX])('round-trips a stored level of %s', (level) => {
    writeSettings({ cameraInnerZoomLevel: level });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].cameraInnerZoomLevel).toBe(level);
  });

  it.each([
    [Number.NaN],
    ['3'],
    [null],
    [{}],
    [Number.POSITIVE_INFINITY],
  ])('lands on the default for the junk value %s, which would otherwise reach the camera', (stored) => {
    writeSettings({ cameraInnerZoomLevel: stored });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].cameraInnerZoomLevel).toBe(PERSISTED_SETTINGS_DEFAULTS.cameraInnerZoomLevel);
  });

  it('clamps and rounds into the range the picker can produce', () => {
    expect(normalizeInnerZoomLevel(99_999)).toBe(INNER_ZOOM_LEVEL_MAX);
    expect(normalizeInnerZoomLevel(-3)).toBe(INNER_ZOOM_LEVEL_MIN);
    expect(normalizeInnerZoomLevel(3.4)).toBe(3);
  });
});

describe('fixedChatboxVisible', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('defaults on, because the client it imitates has no way to hide the chatbox', () => {
    writeSettings({ clientLayoutMode: 'fixed' });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].fixedChatboxVisible).toBe(true);
  });

  it.each([['yes'], [0], [null], [{}]])('coerces the non-boolean %s the replay schema would refuse', (stored) => {
    writeSettings({ fixedChatboxVisible: stored });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].fixedChatboxVisible).toBe(true);
  });

  it('keeps a stored false, which is a real preference and not a missing value', () => {
    writeSettings({ fixedChatboxVisible: false });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].fixedChatboxVisible).toBe(false);
  });
});

describe('transparentChatbox', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('defaults on for a player with nothing stored', () => {
    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].transparentChatbox).toBe(true);
  });

  it('gives transparent to stored settings without the option', () => {
    writeSettings({ clientLayoutMode: 'modern', fixedChatboxVisible: true });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].transparentChatbox).toBe(true);
  });

  it('keeps a stored false, which is a choice', () => {
    writeSettings({ transparentChatbox: false });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].transparentChatbox).toBe(false);
  });

  it('clicks through by default, as the game does, and keeps a stored false', () => {
    expect(renderHook(() => usePersistedSettings()).result.current[0].clickThroughTransparentChatbox).toBe(true);

    localStorage.clear();
    writeSettings({ clickThroughTransparentChatbox: false });

    expect(renderHook(() => usePersistedSettings()).result.current[0].clickThroughTransparentChatbox).toBe(false);
  });
});

describe('resolveRequestedFrameSize', () => {
  const fitResolution = { ...PERSISTED_SETTINGS_DEFAULTS.gameResolution };
  const lockedResolution = { mode: 'fixed' as const, width: 1280, height: 720, presetId: 'hd-720' as const };

  it('reads Fixed as a multiple of the 765x503 client', () => {
    expect(resolveRequestedFrameSize('fixed', fitResolution, 2)).toEqual({ width: 1530, height: 1006 });
  });

  it('reads the resizable layouts as their locked resolution', () => {
    expect(resolveRequestedFrameSize('classic', lockedResolution, 3)).toEqual({ width: 1280, height: 720 });
  });

  it('returns null when the frame is asked to fill the window', () => {
    expect(resolveRequestedFrameSize('fixed', lockedResolution, 'fit')).toBeNull();
    expect(resolveRequestedFrameSize('modern', fitResolution, 2)).toBeNull();
  });
});

describe('usePersistedSettings gameResolution normalization', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns the fit-mode default when no gameResolution is stored', () => {
    writeSettings({ showCoordinates: true });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].gameResolution).toEqual({
      mode: 'fit',
      width: 765,
      height: 503,
      presetId: 'fit',
    });
  });

  it.each([
    ['missing', { mode: 'fixed', width: 1920, height: 1080 }],
    ['invalid', { mode: 'fixed', width: 765, height: 503, presetId: 'bogus-value' }],
  ])('falls back to the default resolution when the stored presetId is %s', (_label, gameResolution) => {
    writeSettings({ gameResolution });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].gameResolution).toEqual(PERSISTED_SETTINGS_DEFAULTS.gameResolution);
  });

  it('preserves a valid stored presetId even if it does not match the dimensions', () => {
    writeSettings({
      gameResolution: { mode: 'fixed', width: 1920, height: 1080, presetId: 'custom' },
    });

    const { result } = renderHook(() => usePersistedSettings());

    // 1920x1080 matches the hd-1080 preset, but stored presetId='custom'
    // wins — the user explicitly chose Custom and we honor it.
    expect(result.current[0].gameResolution.presetId).toBe('custom');
    expect(result.current[0].gameResolution.width).toBe(1920);
  });

  it('clamps out-of-range widths into [320, 7680]', () => {
    writeSettings({
      gameResolution: { mode: 'fixed', width: 99, height: 503, presetId: 'custom' },
    });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].gameResolution.width).toBe(320);
  });

  it('clamps out-of-range heights into [320, 7680]', () => {
    writeSettings({
      gameResolution: { mode: 'fixed', width: 765, height: 99999, presetId: 'custom' },
    });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].gameResolution.height).toBe(7680);
  });

  it('recovers from a non-finite width by falling back to the default width', () => {
    writeSettings({
      gameResolution: { mode: 'fixed', width: Number.NaN, height: 503, presetId: 'custom' },
    });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].gameResolution.width).toBe(765);
  });
});

describe('usePersistedSettings renderer validation on load', () => {
  beforeEach(() => {
    localStorage.clear();
    setStorageNamespace('');
  });

  afterEach(() => {
    setStorageNamespace('');
  });

  it.each(['webgl', 'canvas2d'] as const)('preserves the stored renderer %s', (rendererType) => {
    writeSettings({ rendererType });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].rendererType).toBe(rendererType);
  });

  it.each([
    'none',
    'nonsense',
    42,
    null,
  ])('falls back to the default renderer for the out-of-band value %p', (rendererType) => {
    // 'none' is the UI harness's no-viewport mode. Reaching a real user through
    // hand-edited or stale storage would leave them staring at an empty scene.
    writeSettings({ rendererType });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].rendererType).toBe(PERSISTED_SETTINGS_DEFAULTS.rendererType);
  });

  it('does not broadcast settings to other windows while persistence is namespaced', () => {
    const posted: unknown[] = [];
    class RecordingChannel {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage(message: unknown): void {
        posted.push(message);
      }
      close(): void {}
    }
    vi.stubGlobal('BroadcastChannel', RecordingChannel);
    setStorageNamespace('ui-harness:');

    const { result } = renderHook(() => usePersistedSettings());
    act(() => result.current[1]('showCoordinates', true));

    // A broadcast carries the whole payload, so a real app tab would apply the
    // harness's settings and persist them under its own unprefixed keys.
    expect(posted).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('normalizes a malformed broadcast rather than trusting the other tab', () => {
    // A tab on a different app version can broadcast a layout mode this build does
    // not know. Untreated it reaches GamePanel, which renders anything !== 'modern'
    // as the classic column, and a NaN scale reaches fitFixedFrame.
    let deliver: ((event: MessageEvent) => void) | null = null;
    class RecordingChannel {
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        deliver = handler;
      }
      postMessage(): void {}
      close(): void {}
    }
    vi.stubGlobal('BroadcastChannel', RecordingChannel);

    const { result } = renderHook(() => usePersistedSettings());
    act(() => {
      deliver?.({
        data: {
          type: 'settings-updated',
          settings: { ...PERSISTED_SETTINGS_DEFAULTS, clientLayoutMode: 'resizable', fixedLayoutScale: Number.NaN },
        },
      } as MessageEvent);
    });

    expect(result.current[0].clientLayoutMode).toBe('modern');
    expect(result.current[0].fixedLayoutScale).toBe('fit');
    vi.unstubAllGlobals();
  });

  // Both are recorded into every replay, whose strict schema rejects the whole recording over
  // one unusable value.
  it('normalizes uiScale and speedMultiplier from storage and from a broadcast', () => {
    writeSettings({ uiScale: 'huge', speedMultiplier: Number.NaN });
    const { result: fromStorage } = renderHook(() => usePersistedSettings());

    expect(fromStorage.current[0].uiScale).toBe(PERSISTED_SETTINGS_DEFAULTS.uiScale);
    expect(fromStorage.current[0].speedMultiplier).toBe(PERSISTED_SETTINGS_DEFAULTS.speedMultiplier);

    let deliver: ((event: MessageEvent) => void) | null = null;
    class RecordingChannel {
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        deliver = handler;
      }
      postMessage(): void {}
      close(): void {}
    }
    vi.stubGlobal('BroadcastChannel', RecordingChannel);
    const { result } = renderHook(() => usePersistedSettings());

    act(() => {
      deliver?.({
        data: {
          type: 'settings-updated',
          settings: { ...PERSISTED_SETTINGS_DEFAULTS, uiScale: 99, speedMultiplier: 7 },
        },
      } as MessageEvent);
    });

    expect(result.current[0].uiScale).toBe(PERSISTED_SETTINGS_DEFAULTS.uiScale);
    expect(result.current[0].speedMultiplier).toBe(PERSISTED_SETTINGS_DEFAULTS.speedMultiplier);
    vi.unstubAllGlobals();
  });

  it('preserves UI scales through 300 percent and clamps larger valid values', () => {
    writeSettings({ uiScale: 3 });
    const atLimit = renderHook(() => usePersistedSettings());

    expect(atLimit.result.current[0].uiScale).toBe(3);
    atLimit.unmount();

    writeSettings({ uiScale: 4 });
    const aboveLimit = renderHook(() => usePersistedSettings());
    expect(aboveLimit.result.current[0].uiScale).toBe(3);
  });

  it('keeps a panel the user placed when another position is unreadable', () => {
    writeSettings({
      gamePanelPosition: { x: 'left', y: 3 },
      minimapPosition: { x: 12, y: 34, anchorX: 'left', anchorY: 'bottom' },
    });

    const { result } = renderHook(() => usePersistedSettings());

    expect(result.current[0].gamePanelPosition).toEqual(PERSISTED_SETTINGS_DEFAULTS.gamePanelPosition);
    expect(result.current[0].minimapPosition).toEqual({ x: 12, y: 34, anchorX: 'left', anchorY: 'bottom' });
  });
});

describe('mobile hotkeys settings', () => {
  it('defaults to Jagex’s bossing loadout with panels opening on the right', () => {
    expect(PERSISTED_SETTINGS_DEFAULTS.mobileHotkeys).toEqual([22, 23, 8, 9, 21]);
    expect(PERSISTED_SETTINGS_DEFAULTS.mobileHotkeysOpenOnLeft).toBe(false);
  });

  it('keeps five slots, emptying only a slot it does not recognize', () => {
    expect(normalizeMobileHotkeys([6, 999, 0, 22, 'x'])).toEqual([6, 0, 0, 22, 0]);
    expect(normalizeMobileHotkeys([6, 8])).toEqual([22, 23, 8, 9, 21]);
    expect(normalizeMobileHotkeys(null)).toEqual([22, 23, 8, 9, 21]);
    expect(normalizeMobileHotkeys([6, 8, 9, 21, 23])).toEqual([6, 8, 9, 21, 23]);
    // Hotkey types the simulator cannot act on (Tap-to-drop, Logout Tab) are not kept.
    expect(normalizeMobileHotkeys([1, 19, 6, 6, 6])).toEqual([0, 0, 6, 6, 6]);
  });
});

describe('mobile interface scaling setting', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to 400% and keeps any of the slider’s stops', () => {
    expect(PERSISTED_SETTINGS_DEFAULTS.mobileInterfaceScaling).toBe(400);
    for (const value of [175, 200, 325, 400]) {
      expect(normalizeSettings({ mobileInterfaceScaling: value }).mobileInterfaceScaling).toBe(value);
    }
  });

  it('falls back to 400% for anything the slider cannot hold', () => {
    for (const value of [150, 0, 210, 425, 1000, -175, Number.NaN, '200', null, [200]]) {
      expect(normalizeSettings({ mobileInterfaceScaling: value }).mobileInterfaceScaling).toBe(400);
    }
  });

  it('persists a change', () => {
    const { result, unmount } = renderHook(() => usePersistedSettings());
    act(() => result.current[1]('mobileInterfaceScaling', 250));
    unmount();

    const remounted = renderHook(() => usePersistedSettings());
    expect(remounted.result.current[0].mobileInterfaceScaling).toBe(250);
    remounted.unmount();
  });
});
