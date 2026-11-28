import type { GamePanelTab } from '../../hooks/keybindStore';
import type { RenderStatus } from '../../render/core/renderer';
import type { HarnessOutcome } from '../devHarnessTypes';
import { isTerminalSurface } from './harnessSurfaces';
import { isReplayChapterFixture, type ReplayChapterFixture } from './replayChapterFixture';

/**
 * Everything the UI harness reads out of the URL. Each option maps to a query
 * parameter so a Playwright run reaches a deterministic screen in a single
 * navigation, with no scripted click-through.
 */
export interface HarnessOptions {
  /** Encounter whose UI is mounted (any registered encounter kind, plus `lobby`). */
  encounter: string;
  /** Equipment preset key inside `EQUIPMENT_PRESETS[<presetsKey>]`; `first` picks the first real set. */
  preset: string;
  /** Game panel tab to open on mount. */
  tab: GamePanelTab;
  /** Run the tick loop in real time. Off by default so screens are deterministic. */
  autoAdvance: boolean;
  /** Ticks to advance before signaling ready. */
  ticks: number;
  /** Show the harness toolbar. Turn off for clean screenshots. */
  chrome: boolean;
  /**
   * Named terminal QA endings are deliberately limited to the base Yama encounter. The same fixture
   * as the `death` and `victory` surfaces: `?outcome=death` and `?open=death` are one request.
   */
  outcome: HarnessOutcome | null;
  /** With a terminal fixture (`outcome`, or `open` naming death or victory), start practice at tick 10. */
  practice: boolean;
  /**
   * UI surfaces to open once ready, in order (`?open=settings`, `?open=hardware-warning,victory`).
   * Kept as written: an unknown name fails the boot with the list of known ones (harnessSurfaces.ts).
   */
  open: readonly string[];
  /**
   * Named configurer selection, applied at boot and saved like a player's choice (in harness
   * storage). Kept as written so boot reports unknown/incompatible requests.
   */
  modifierFixture: string | null;
  /**
   * A 3D-view status to preview (`?renderStatus=context-timeout`). Not a surface: the harness
   * mounts no renderer, so RenderStatusPreview shows the notice on its own layer instead.
   */
  renderStatus: RenderStatus | null;
  /**
   * What App's graphics hold has paused behind that status (`?renderStatusHeld=fight`), which the
   * notice names. `null` is the lobby, loading, or a fight already over.
   */
  renderStatusHeld: 'fight' | 'replay' | null;
  /**
   * A chaptered replay transport to preview (`?replayChapters=full`). Not a surface either: the
   * chapters of a real recording need the OSRS cache and a long Inferno run, so
   * `ReplayChaptersPreview` mounts the bar over a synthetic one. `replayChaptersCompact` picks the
   * narrow form the app uses below 720px, `replayChaptersMobile` the tool window's band.
   */
  replayChapters: ReplayChapterFixture | null;
  replayChaptersCompact: boolean;
  replayChaptersMobile: boolean;
  /**
   * The Fortis Colosseum start wave (`?encounter=sol_heredit&colosseumStartWave=4`), saved before
   * the app mounts like a player's Start wave choice, so the run opens on that wave's modifier choice.
   * `null` for anything but a whole wave 1-12 in `sol_heredit`.
   */
  colosseumStartWave: number | null;
}

/**
 * What `?renderStatus=` can name: the two recovering states, and each failure reason by name.
 * An unrecognized value is ignored, as `?outcome=` ignores one.
 */
export const RENDER_STATUS_PREVIEWS = {
  lost: { kind: 'lost' },
  restoring: { kind: 'restoring' },
  'context-restore': { kind: 'failed', reason: 'context-restore' },
  'context-timeout': { kind: 'failed', reason: 'context-timeout' },
  'render-loop': { kind: 'failed', reason: 'render-loop' },
  unsupported: { kind: 'failed', reason: 'unsupported' },
} as const satisfies Record<string, RenderStatus>;

const GAME_PANEL_TABS: readonly GamePanelTab[] = [
  'combat',
  'skills',
  'inventory',
  'equipment',
  'prayer',
  'spellbook',
  'settings',
];

function isGamePanelTab(value: string | null): value is GamePanelTab {
  return value !== null && (GAME_PANEL_TABS as readonly string[]).includes(value);
}

function boolParam(params: URLSearchParams, key: string, fallback: boolean): boolean {
  const raw = params.get(key);
  if (raw === null) return fallback;
  return raw !== '0' && raw !== 'false';
}

function intParam(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const HARNESS_DEFAULT_OPTIONS: HarnessOptions = {
  encounter: 'yama_p3',
  preset: 'first',
  tab: 'inventory',
  autoAdvance: false,
  ticks: 0,
  chrome: true,
  outcome: null,
  practice: false,
  open: [],
  modifierFixture: null,
  renderStatus: null,
  renderStatusHeld: null,
  replayChapters: null,
  replayChaptersCompact: false,
  replayChaptersMobile: false,
  colosseumStartWave: null,
};

/**
 * Whether a boot installs a terminal fixture, through `outcome` or a `death`/`victory` surface in
 * `open`. Such a boot stops at the fixture's tick: it skips `ticks` and leaves auto-advance off.
 */
export function opensTerminalFixture(options: Pick<HarnessOptions, 'outcome' | 'open'>): boolean {
  return options.outcome !== null || options.open.some(isTerminalSurface);
}

/**
 * Every surface a boot opens, in order: `?outcome=` is the terminal surface by its fixture name, so
 * it comes first, and naming it again in `open` is a duplicate (harnessSurfaces.ts parseSurfaceList).
 */
export function surfaceRequests(options: Pick<HarnessOptions, 'outcome' | 'open'>): string[] {
  return [...(options.outcome ? [options.outcome] : []), ...options.open];
}

export function parseHarnessOptions(search: string): HarnessOptions {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  const encounter = params.get('encounter') ?? HARNESS_DEFAULT_OPTIONS.encounter;
  const rawOutcome = params.get('outcome');
  const outcome = encounter === 'yama_p3' && (rawOutcome === 'death' || rawOutcome === 'victory') ? rawOutcome : null;
  const open = (params.get('open') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const rawRenderStatus = params.get('renderStatus');
  const rawRenderStatusHeld = params.get('renderStatusHeld');
  const rawReplayChapters = params.get('replayChapters');
  const rawStartWave = params.get('colosseumStartWave');
  const startWave = rawStartWave !== null && /^\d+$/.test(rawStartWave) ? Number(rawStartWave) : Number.NaN;

  return {
    encounter,
    preset: params.get('preset') ?? HARNESS_DEFAULT_OPTIONS.preset,
    tab: isGamePanelTab(tab) ? tab : HARNESS_DEFAULT_OPTIONS.tab,
    autoAdvance: boolParam(params, 'autoAdvance', HARNESS_DEFAULT_OPTIONS.autoAdvance),
    ticks: intParam(params, 'ticks', HARNESS_DEFAULT_OPTIONS.ticks),
    chrome: boolParam(params, 'chrome', HARNESS_DEFAULT_OPTIONS.chrome),
    outcome,
    practice: opensTerminalFixture({ outcome, open }) && boolParam(params, 'practice', false),
    open,
    modifierFixture: params.get('modifierFixture'),
    renderStatus:
      rawRenderStatus !== null && Object.hasOwn(RENDER_STATUS_PREVIEWS, rawRenderStatus)
        ? RENDER_STATUS_PREVIEWS[rawRenderStatus as keyof typeof RENDER_STATUS_PREVIEWS]
        : null,
    renderStatusHeld: rawRenderStatusHeld === 'fight' || rawRenderStatusHeld === 'replay' ? rawRenderStatusHeld : null,
    replayChapters: isReplayChapterFixture(rawReplayChapters) ? rawReplayChapters : null,
    replayChaptersCompact: boolParam(params, 'replayChaptersCompact', false),
    replayChaptersMobile: boolParam(params, 'replayChaptersMobile', false),
    colosseumStartWave: encounter === 'sol_heredit' && startWave >= 1 && startWave <= 12 ? startWave : null,
  };
}

export { GAME_PANEL_TABS };
