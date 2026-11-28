// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { type ComponentProps, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EncounterRegistry } from '../../core/encounters/encounterFactory';
import { ENCOUNTER_CORE_MODULES } from '../../encounters/modules';
import { encounterRegistry } from '../../encounters/registry';
import { YAMA_CONTRACTS } from '../../encounters/yamaP3/contracts';
import { useAppHotkeys } from '../../hooks/useAppHotkeys';
import { encounterSearchEntries } from '../../settingsSearch/encounters';
import { SETTINGS_SEARCH_ENTRIES } from '../../settingsSearch/entries';
import { GAMEPANEL_AUDIO_IDS, GAMEPANEL_KEYBINDS_ID, settingsSearchId } from '../../settingsSearch/ids';
import { TUTORIAL_QUICK_SEARCH_OPENED_EVENT } from '../../tutorial/events';
import {
  encounterSearchSources,
  QUICK_SEARCH_PLACEHOLDER,
  QuickSearch,
  quickSearchType,
  rankQuickSearch,
} from '../QuickSearch';
import { SidebarSearchBar, SidebarSearchToggle, useSearchIds, useSidebarSearch } from '../SidebarSearch';
import { getRevealAvailability, revealSetting } from '../settingsReveal';

vi.mock('../settingsReveal', () => ({
  getRevealAvailability: vi.fn(() => ({ ok: true })),
  revealSetting: vi.fn(() => ({ ok: true })),
  useSettingsRevealListener: vi.fn(),
}));

// The real encounters' picker data, so the words the quick search indexes are the shipped ones.
const SOURCES = [
  {
    kind: 'yama_p3',
    title: 'Yama',
    displayName: 'Yama - Phase 3',
    description: 'The Yama boss encounter',
    tagline: 'Phase 3 · The Judge of the Dead',
    isWorkInProgress: false,
    variants: YAMA_CONTRACTS,
  },
  {
    kind: 'zuk',
    title: 'TzKal-Zuk',
    displayName: 'TzKal-Zuk',
    description: 'The final wave of the Inferno.',
    tagline: 'Inferno · Wave 69',
    isWorkInProgress: true,
    variants: [],
  },
  {
    kind: 'sol_heredit',
    title: 'Sol Heredit',
    displayName: 'Sol Heredit',
    description: 'The final wave of the Fortis Colosseum.',
    tagline: 'Fortis Colosseum · Wave 12',
    isWorkInProgress: true,
    variants: [],
  },
];
const ENTRIES = [...encounterSearchEntries(SOURCES), ...SETTINGS_SEARCH_ENTRIES];
const top = (query: string) => rankQuickSearch(query, ENTRIES, 'resizable').results[0]?.entry.id;

describe('encounter entries', () => {
  // Built from the live registry, not written by hand: a new encounter module needs no search work.
  it('lists every encounter the manifest ships, and each playable contract', () => {
    const ids = new Set(encounterSearchEntries(encounterSearchSources(encounterRegistry)).map((entry) => entry.id));
    const expected: string[] = [];
    for (const { kind, descriptor } of ENCOUNTER_CORE_MODULES) {
      if (kind === 'lobby') continue;
      expected.push(`encounter.${kind}`);
      for (const variant of descriptor.variants ?? []) {
        // The base row is the encounter itself; a contract not yet playable is a "Soon" row.
        if (variant.encounterKind !== kind && variant.available) expected.push(`encounter.${kind}.${variant.id}`);
      }
    }
    expect(expected.length).toBeGreaterThanOrEqual(3);
    expect(expected.filter((id) => !ids.has(id))).toEqual([]);
    // Nothing else: no lobby, no stale or hand-added encounter rows.
    expect([...ids].filter((id) => !expected.includes(id))).toEqual([]);
  });

  it('finds the Inferno as one encounter, TzKal-Zuk included', () => {
    const entries = [...encounterSearchEntries(encounterSearchSources(encounterRegistry)), ...SETTINGS_SEARCH_ENTRIES];
    const topEntry = (query: string) => rankQuickSearch(query, entries, 'resizable').results[0]?.entry;
    const selectionOf = (query: string) => {
      const entry = topEntry(query);
      return entry?.kind === 'encounter' ? { kind: entry.encounterKind, variantId: entry.variantId } : entry?.id;
    };
    expect(topEntry('inferno')?.id).toBe('encounter.inferno');
    expect(topEntry('inferno')?.title).toBe('The Inferno');
    for (const query of ['inferno', 'tzkal'])
      expect(selectionOf(query)).toEqual({ kind: 'inferno', variantId: undefined });
    // Both wave encounters answer "waves"; each is one entry.
    expect(
      rankQuickSearch('waves', entries, 'resizable')
        .results.slice(0, 2)
        .map((result) => result.entry.id)
        .sort(),
    ).toEqual(['encounter.inferno', 'encounter.sol_heredit']);
    // "zuk" is also the Zuk set timer plugin's word; the Inferno is still offered for it.
    expect(rankQuickSearch('zuk', entries, 'resizable').results.map((result) => result.entry.id)).toContain(
      'encounter.inferno',
    );
    expect(entries.some((entry) => entry.id.startsWith('encounter.zuk'))).toBe(false);
  });
});

describe('rankQuickSearch', () => {
  it('finds encounters by the names players use, ahead of settings that share a word', () => {
    expect(top('zuk')).toBe('encounter.zuk');
    expect(top('infernp')).toBe('encounter.zuk');
    expect(top('yama')).toBe('encounter.yama_p3');
    expect(top('sol')).toBe('encounter.sol_heredit');
    expect(top('forfeit')).toBe('encounter.yama_p3.forfeit_breath');
  });

  it('puts a plugin named by the arena first, with the encounter, known by a tagline word, next', () => {
    // A title that starts with the word outranks the encounter's lead: the player named that row.
    // Outside its arena the plugin is listed under "Available elsewhere", below the encounter.
    const ranked = (query: string) =>
      rankQuickSearch(query, ENTRIES, 'resizable')
        .results.slice(0, 2)
        .map((result) => result.entry.id);
    expect(ranked('inferno')).toEqual(['plugins.infernoAdditions', 'encounter.zuk']);
    expect(ranked('colosseum')).toEqual(['plugins.colosseumAdditions', 'encounter.sol_heredit']);
  });

  it('still finds settings, plugins and keybinds as the sidebars do', () => {
    expect(top('fps cap')).toBe('settings.graphics-performance.fps-cap');
    expect(top('keybinds')).toBe(GAMEPANEL_KEYBINDS_ID);
    expect(top('volume')).toBe(GAMEPANEL_AUDIO_IDS.masterVolume);
    expect(top('ground markers')).toMatch(/^plugins\./);
  });

  it('offers nothing for nonsense, rather than padding the list', () => {
    expect(rankQuickSearch('xyzzy', ENTRIES, 'resizable')).toEqual({ results: [], suggested: true });
  });

  it('lists only encounters that are registered, and a contract under its boss', () => {
    const ids = encounterSearchEntries(SOURCES).map((entry) => entry.id);
    expect(ids).toContain('encounter.yama_p3.bloodied_blows');
    // "No Contract" is Yama itself.
    expect(ids.filter((id) => id.startsWith('encounter.yama_p3'))).toHaveLength(6);
    expect(rankQuickSearch('vardorvis', ENTRIES, 'resizable').results.some((r) => r.entry.kind === 'encounter')).toBe(
      false,
    );
  });

  it('labels each row by type', () => {
    const byId = new Map(ENTRIES.map((entry) => [entry.id, entry]));
    const type = (id: string) => quickSearchType(byId.get(id) as (typeof ENTRIES)[number]);
    expect(type('encounter.zuk')).toBe('Encounter');
    expect(type('settings.graphics-performance.fps-cap')).toBe('Setting');
    expect(type('plugins.setTimer')).toBe('Plugin');
    expect(type(GAMEPANEL_KEYBINDS_ID)).toBe('Keybind');
    expect(type(GAMEPANEL_AUDIO_IDS.masterVolume)).toBe('Setting');
  });
});

function createRegistry() {
  const registry = new EncounterRegistry();
  for (const source of SOURCES) {
    registry.register(source.kind, () => ({}) as never, {
      kind: source.kind,
      displayName: source.displayName,
      description: source.description,
      mapSquare: { x: 0, y: 0 },
      playerStart: [0, 0],
      variants: source.variants.length > 0 ? [...source.variants] : undefined,
      isWorkInProgress: source.isWorkInProgress,
    });
  }
  registry.register('lobby', () => ({}) as never, {
    kind: 'lobby',
    displayName: 'Lobby',
    description: 'Hub',
    mapSquare: { x: 0, y: 0 },
    playerStart: [0, 0],
  });
  return registry;
}

function renderSearch(overrides: Partial<ComponentProps<typeof QuickSearch>> = {}) {
  const props: ComponentProps<typeof QuickSearch> = {
    isOpen: true,
    onClose: vi.fn(),
    encounterRegistry: createRegistry(),
    layout: 'resizable',
    onChooseEncounter: vi.fn(),
    onBrowseEncounters: vi.fn(),
    ...overrides,
  };
  const utils = render(<QuickSearch {...props} />);
  return { ...utils, props };
}

const field = () => screen.getByPlaceholderText(QUICK_SEARCH_PLACEHOLDER) as HTMLInputElement;
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
const selectedTitle = () =>
  document.querySelector('[role="option"][aria-selected="true"] .drawer-search-result__title')?.textContent;

describe('QuickSearch', () => {
  beforeEach(() => {
    vi.mocked(getRevealAvailability).mockReturnValue({ ok: true });
    vi.mocked(revealSetting).mockReturnValue({ ok: true });
  });

  afterEach(() => {
    vi.mocked(getRevealAvailability).mockReset();
    vi.mocked(revealSetting).mockReset();
  });

  it('renders nothing while closed', () => {
    renderSearch({ isOpen: false });
    expect(document.querySelector('.quick-search')).toBeNull();
  });

  it('opens as a modal with the caret in its field, listing the encounters, and tells a tour it opened', () => {
    const opened = vi.fn();
    window.addEventListener(TUTORIAL_QUICK_SEARCH_OPENED_EVENT, opened);
    renderSearch();
    window.removeEventListener(TUTORIAL_QUICK_SEARCH_OPENED_EVENT, opened);

    expect(opened).toHaveBeenCalledTimes(1);
    // The tour steps aside for an aria-modal layer (SpotlightRunner's TOUR_SUSPENDING_LAYER).
    expect(document.querySelector('.quick-search')?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(field());
    const titles = [...document.querySelectorAll('[role="option"] .drawer-search-result__title')].map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(['Yama', 'TzKal-Zuk', 'Fortis Colosseum']);
  });

  it('moves the selection with Up and Down, and chooses an encounter with Enter, never starting it', () => {
    const { props } = renderSearch();
    type('yama');
    expect(selectedTitle()).toBe('Yama');
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(selectedTitle()).toBe('Forfeit Breath');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(props.onChooseEncounter).toHaveBeenCalledWith({ kind: 'yama_p3', variantId: 'forfeit_breath' });
  });

  it('wraps the selection around the list', () => {
    renderSearch();
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(selectedTitle()).toBe('Fortis Colosseum');
  });

  it('chooses a row on click, and labels its type', () => {
    const { props } = renderSearch();
    // The fixture registry's own kinds; their picker copy comes from the real presentation manifest,
    // which has no Zuk entry any more, so the row is found by its title.
    type('tzkal');
    const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes('TzKal-Zuk'),
    ) as HTMLElement;
    expect(row.querySelector('.quick-search-row__type')?.textContent).toBe('Encounter');
    fireEvent.click(row);
    expect(props.onChooseEncounter).toHaveBeenCalledWith({ kind: 'zuk' });
  });

  it('reveals a setting where it lives and closes', () => {
    const { props } = renderSearch();
    type('fps cap');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(revealSetting).toHaveBeenCalledWith('settings.graphics-performance.fps-cap');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('shows why a reveal was refused in the row, and stays open', () => {
    vi.mocked(revealSetting).mockReturnValue({ ok: false, reason: 'Not available right now.' });
    const { props } = renderSearch();
    type('fps cap');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(props.onClose).not.toHaveBeenCalled();
    const row = document.querySelector('[role="option"][aria-selected="true"]') as HTMLElement;
    expect(row.querySelector('.drawer-search-result__reason')?.textContent).toBe('Not available right now.');
  });

  it('lists a row that cannot be shown now with its reason, under Available elsewhere', () => {
    vi.mocked(getRevealAvailability).mockImplementation((id: string) =>
      id === GAMEPANEL_KEYBINDS_ID ? { ok: false, reason: 'The game panel is not showing right now.' } : { ok: true },
    );
    const { props } = renderSearch();
    type('keybinds');
    expect(screen.getByText('Available elsewhere')).toBeTruthy();
    const row = screen.getByText('The game panel is not showing right now.').closest('[role="option"]') as HTMLElement;
    expect(row.classList.contains('is-unavailable')).toBe(true);
    fireEvent.click(row);
    expect(revealSetting).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("lists the Audio page with the replay's reason while a replay holds the game panel", () => {
    const reason = 'Audio settings are unavailable while a replay controls the game panel.';
    vi.mocked(getRevealAvailability).mockImplementation((id: string) =>
      id.startsWith('gamepanel.audio') ? { ok: false, reason } : { ok: true },
    );
    const { props } = renderSearch();
    type('volume');
    const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.querySelector('.drawer-search-result__title')?.textContent === 'Master Volume',
    ) as HTMLElement;
    expect(row.classList.contains('is-unavailable')).toBe(true);
    expect(row.querySelector('.drawer-search-result__reason')?.textContent).toBe(reason);
    // The usable metronome volume leads; the blocked Audio rows wait under Available elsewhere.
    expect(selectedTitle()).toBe('Metronome volume');
    fireEvent.click(row);
    expect(revealSetting).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('says so honestly when nothing matches', () => {
    renderSearch();
    type('xyzzy');
    expect(screen.getByText('Nothing found for “xyzzy”.')).toBeTruthy();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
  });

  it('keeps typed keys from the game, and leaves Escape and Ctrl+K to the app', () => {
    const { props } = renderSearch();
    const gameKeys = vi.fn();
    window.addEventListener('keydown', gameKeys);
    try {
      fireEvent.keyDown(field(), { key: 'a' });
      fireEvent.keyDown(field(), { key: 'ArrowDown' });
      fireEvent.keyDown(field(), { key: ' ' });
      expect(gameKeys).not.toHaveBeenCalled();

      fireEvent.keyDown(field(), { key: 'k', ctrlKey: true });
      expect(gameKeys).toHaveBeenCalledTimes(1);
      act(() => {
        fireEvent.keyDown(field(), { key: 'Escape' });
      });
      expect(props.onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', gameKeys);
    }
  });

  it('closes on a backdrop click and opens the full picker from its footer', () => {
    const { props } = renderSearch();
    fireEvent.click(screen.getByRole('button', { name: /Browse all encounters/ }));
    expect(props.onBrowseEncounters).toHaveBeenCalledTimes(1);
    const overlay = document.querySelector('.quick-search-overlay') as HTMLElement;
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const titleOf = (option: Element) => option.querySelector('.drawer-search-result__title')?.textContent ?? '';
const footerKeys = () =>
  [...document.querySelectorAll('.quick-search__keys > span')]
    .map((hint) => hint.textContent?.replace(/\s+/g, ' ').trim())
    .join(' ');
const press = (key: string) => fireEvent.keyDown(field(), { key });

describe('QuickSearch: the keyboard', () => {
  beforeEach(() => {
    vi.mocked(getRevealAvailability).mockReturnValue({ ok: true });
    vi.mocked(revealSetting).mockReturnValue({ ok: true });
  });

  afterEach(() => {
    vi.mocked(getRevealAvailability).mockReset();
    vi.mocked(revealSetting).mockReset();
  });

  it('reaches "Show remaining" last, and Enter on it shows the rest with the first new result selected', () => {
    renderSearch();
    type('show');
    const more = screen.getByRole('button', { name: /^Show remaining/ });
    const before = options().map(titleOf);
    // Up from the first row wraps to the last item: the button, after every row.
    press('ArrowUp');
    expect(field().getAttribute('aria-activedescendant')).toBe(more.id);
    expect(more.classList.contains('is-selected')).toBe(true);
    expect(footerKeys()).toContain('Enter show all');
    press('Enter');
    expect(screen.queryByRole('button', { name: /^Show remaining/ })).toBeNull();
    const firstNew = options().find((option) => !before.includes(titleOf(option)) && !option.ariaDisabled);
    expect(firstNew).toBeDefined();
    expect(selectedTitle()).toBe(titleOf(firstNew as HTMLElement));
  });

  it('passes over rows that are only information, and keeps them listed', () => {
    vi.mocked(getRevealAvailability).mockImplementation((id: string) =>
      id === GAMEPANEL_KEYBINDS_ID ? { ok: false, reason: 'The game panel is not showing right now.' } : { ok: true },
    );
    renderSearch();
    type('keybinds');
    const keybinds = options().find((option) => titleOf(option) === 'Keybinds');
    expect(keybinds?.getAttribute('aria-disabled')).toBe('true');
    const remaining = screen.queryByRole('button', { name: /^Show remaining/ });
    const expectedIds = new Set([
      ...options()
        .filter((option) => option.getAttribute('aria-disabled') !== 'true')
        .map((option) => option.id),
      ...(remaining ? [remaining.id] : []),
    ]);
    const firstId = field().getAttribute('aria-activedescendant');
    const visited = new Set<string | null>();
    for (let i = 0; i < expectedIds.size; i++) {
      visited.add(field().getAttribute('aria-activedescendant'));
      press('ArrowDown');
    }
    expect(visited.has(keybinds?.id ?? '')).toBe(false);
    expect(visited).toEqual(expectedIds);
    expect(field().getAttribute('aria-activedescendant')).toBe(firstId);
  });

  it('selects a row whose prerequisite the player can change, and Enter takes that route', () => {
    renderSearch();
    type('fixed layout scale');
    for (let i = 0; i < options().length && selectedTitle() !== 'Fixed layout scale'; i++) press('ArrowDown');
    expect(selectedTitle()).toBe('Fixed layout scale');
    expect(footerKeys()).toContain('Enter open Layout settings');
    press('Enter');
    expect(revealSetting).toHaveBeenCalledWith(settingsSearchId('Interface', 'Layout'));
  });

  it('selects nothing and offers no Enter when no row can be acted on', () => {
    vi.mocked(getRevealAvailability).mockReturnValue({ ok: false, reason: 'Not available right now.' });
    renderSearch();
    type('fps cap');
    expect(options().length).toBeGreaterThan(0);
    expect(document.querySelector('[role="option"][aria-selected="true"]')).toBeNull();
    expect(field().hasAttribute('aria-activedescendant')).toBe(false);
    expect(footerKeys()).toBe('Esc close');
    press('Enter');
    expect(revealSetting).not.toHaveBeenCalled();
  });

  it('names what Enter will do in the footer', () => {
    renderSearch();
    expect(footerKeys()).toBe('move Enter view encounter Esc close');
    type('fps cap');
    expect(footerKeys()).toBe('Enter open Esc close');
    type('xyzzy');
    expect(footerKeys()).toBe('Esc close');
    expect(screen.getByRole('button', { name: /Browse all encounters/ })).toBeDefined();
  });
});

describe('QuickSearch: the next Ctrl+K', () => {
  beforeEach(() => {
    vi.mocked(getRevealAvailability).mockReturnValue({ ok: true });
    vi.mocked(revealSetting).mockReturnValue({ ok: true });
  });

  afterEach(() => {
    vi.mocked(getRevealAvailability).mockReset();
    vi.mocked(revealSetting).mockReset();
  });

  /** Closes the quick search and opens it again, as the next Ctrl+K does: the dialog remounts. */
  function reopen(view: ReturnType<typeof renderSearch>) {
    view.rerender(<QuickSearch {...view.props} isOpen={false} />);
    view.rerender(<QuickSearch {...view.props} isOpen />);
  }

  it('opens empty after a search that went somewhere', () => {
    const view = renderSearch();
    type('show');
    press('ArrowDown');
    press('Enter');
    expect(revealSetting).toHaveBeenCalled();
    reopen(view);

    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
  });

  it('opens empty after a search that was dismissed', () => {
    const view = renderSearch();
    type('fps cap');
    press('Enter');
    reopen(view);
    type('zuk');
    reopen(view);
    expect(field().value).toBe('');
  });
});

/** The app's Ctrl+K, a Settings sidebar field and the quick search, as App wires them. */
function AppStandIn({
  onReset = () => {},
  triggerHintToast = () => {},
}: {
  onReset?: () => void;
  triggerHintToast?: (type: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useAppHotkeys({
    onReset,
    onToggleQuickSearch: () => setOpen((value) => !value),
    onToggleShowFps: () => {},
    triggerHintToast,
  });
  const search = useSidebarSearch('settings', true);
  const { fieldId, resultsId } = useSearchIds();
  return (
    <>
      <aside data-testid="settings">
        <SidebarSearchToggle search={search} fieldId={fieldId} />
        <SidebarSearchBar search={search} fieldId={fieldId} resultsId={resultsId} />
      </aside>
      <QuickSearch
        isOpen={open}
        onClose={() => setOpen(false)}
        encounterRegistry={createRegistry()}
        layout="resizable"
        onChooseEncounter={() => {}}
        onBrowseEncounters={() => {}}
      />
    </>
  );
}

describe('QuickSearch: Ctrl+K from a sidebar search', () => {
  afterEach(() => {
    cleanup();
  });

  it('opens over the sidebar field and takes the typing', () => {
    render(<AppStandIn />);
    const settings = screen.getByTestId('settings');
    const toggle = within(settings).getByRole('button', { name: 'Search settings and plugins' });
    fireEvent.pointerDown(toggle, { pointerType: 'mouse' });
    fireEvent.click(toggle);
    const sidebarField = within(settings).getByRole('textbox');
    expect(document.activeElement).toBe(sidebarField);
    act(() => {
      fireEvent.keyDown(sidebarField, { key: 'k', ctrlKey: true });
    });
    expect(document.querySelector('.quick-search')).not.toBeNull();
    expect(document.activeElement).toBe(field());
    type('zuk');
    expect(selectedTitle()).toBe('TzKal-Zuk');
  });
});

describe("search fields and the browser's shortcuts", () => {
  afterEach(() => {
    cleanup();
  });

  /** Dispatches a real keydown on `target` and reports whether the browser's default was canceled. */
  function pressIn(target: HTMLElement, init: KeyboardEventInit): boolean {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event.defaultPrevented;
  }

  /** One of the two fields, as App wires them with its window-level key policy (useAppHotkeys). */
  function fieldFor(which: 'quick' | 'sidebar') {
    const onReset = vi.fn();
    const triggerHintToast = vi.fn();
    render(<AppStandIn onReset={onReset} triggerHintToast={triggerHintToast} />);
    let target: HTMLInputElement;
    if (which === 'sidebar') {
      const settings = screen.getByTestId('settings');
      const toggle = within(settings).getByRole('button', { name: 'Search settings and plugins' });
      fireEvent.pointerDown(toggle, { pointerType: 'mouse' });
      fireEvent.click(toggle);
      target = within(settings).getByRole('textbox') as HTMLInputElement;
    } else {
      act(() => {
        fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
      });
      target = field();
    }
    expect(document.activeElement).toBe(target);
    return { target, onReset, triggerHintToast };
  }

  it.each([
    'quick',
    'sidebar',
  ] as const)('keeps reload, help and zoom from the browser in the %s search, and Ctrl+R restarts as anywhere else', (which) => {
    const all = fieldFor(which);
    const { target } = all;
    // Reload and help would lose the session; zoom would scale the whole page.
    expect(pressIn(target, { key: 'r', ctrlKey: true })).toBe(true);
    expect(all.onReset).toHaveBeenCalledOnce();
    expect(pressIn(target, { key: 'R', metaKey: true })).toBe(true);
    expect(pressIn(target, { key: 'F1' })).toBe(true);
    expect(pressIn(target, { key: 'F5' })).toBe(true);
    expect(pressIn(target, { key: '=', ctrlKey: true })).toBe(true);
    expect(all.triggerHintToast).toHaveBeenCalledWith('resize', expect.anything());
  });

  it.each(['quick', 'sidebar'] as const)('leaves text editing in the %s search to the field', (which) => {
    const { target } = fieldFor(which);
    for (const init of [
      { key: 'a', ctrlKey: true },
      { key: 'c', ctrlKey: true },
      { key: 'v', ctrlKey: true },
      { key: 'x', ctrlKey: true },
      { key: 'z', ctrlKey: true },
      { key: 'ArrowLeft' },
      { key: 'Home' },
      { key: 'End' },
      { key: 'Backspace' },
      { key: 'q' },
      { key: 'r', ctrlKey: true, shiftKey: true },
    ]) {
      expect(pressIn(target, init), JSON.stringify(init)).toBe(false);
    }
  });
});
