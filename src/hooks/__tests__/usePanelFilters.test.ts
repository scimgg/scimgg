// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayPresentationProvider } from '../../contexts/ReplayPresentationContext';
import type { ReplayPanelPresentation, ReplayPresentationState } from '../../core/replayPresentation';
import { ReplayPresentationStateSchema } from '../../replay/format/presentationFormat';
import { ALL_SPELL_CATEGORIES } from '../../types/panelFilters';
import { PrayerType } from '../../types/simulation';
import { PRAYER_FILTER_DEFAULTS, SPELL_FILTER_DEFAULTS, usePanelFilters } from '../usePanelFilters';

type StoredSettings = Record<string, unknown> | null;

const storageMocks = vi.hoisted(() => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(),
}));

vi.mock('../../util/storage', () => ({
  loadSetting: storageMocks.loadSetting,
  saveSetting: storageMocks.saveSetting,
}));

describe('usePanelFilters', () => {
  let stored: StoredSettings;

  beforeEach(() => {
    stored = null;
    storageMocks.loadSetting.mockReset();
    storageMocks.saveSetting.mockReset();
    storageMocks.loadSetting.mockImplementation(() => stored);
    storageMocks.saveSetting.mockImplementation((_key: string, value: unknown) => {
      stored = value as Record<string, unknown>;
    });
  });

  it('loads default filter state when storage is empty', () => {
    const { result } = renderHook(() => usePanelFilters());

    expect(result.current.prayerFilter.hidden).toEqual([]);
    expect(result.current.prayerFilter.order).toBeNull();
    expect(result.current.prayerFilter.filterOptions).toEqual(PRAYER_FILTER_DEFAULTS);
    expect(result.current.spellbookFilter.hidden).toEqual({});
    expect(result.current.spellbookFilter.order).toEqual({});
    expect(result.current.spellbookFilter.activeCategories).toEqual(ALL_SPELL_CATEGORIES);
    expect(result.current.spellbookFilter.filterOptions).toEqual(SPELL_FILTER_DEFAULTS);
  });

  it('toggles a prayer filter option and persists updated settings', () => {
    const { result } = renderHook(() => usePanelFilters());

    act(() => {
      result.current.togglePrayerFilterOption('showRapidHealing');
    });

    expect(result.current.prayerFilter.filterOptions.showRapidHealing).toBe(false);
    expect(storageMocks.saveSetting).toHaveBeenCalledWith(
      'osrs-panel-filters',
      expect.objectContaining({
        prayer: expect.objectContaining({
          filterOptions: expect.objectContaining({ showRapidHealing: false }),
        }),
      }),
    );
  });

  it('keeps one set of spell filters for every book, like the live varbits, and persists it', () => {
    const { result } = renderHook(() => usePanelFilters());

    act(() => {
      result.current.toggleSpellCategory('combat');
      result.current.toggleSpellFilterOption('showLackRunes');
    });

    expect(result.current.spellbookFilter.activeCategories).toEqual(['teleport', 'utility']);
    expect(result.current.spellbookFilter.filterOptions).toEqual({ ...SPELL_FILTER_DEFAULTS, showLackRunes: false });
    expect(storageMocks.saveSetting).toHaveBeenLastCalledWith(
      'osrs-panel-filters',
      expect.objectContaining({
        spellbook: {
          hidden: {},
          order: {},
          activeCategories: ['teleport', 'utility'],
          filterOptions: { ...SPELL_FILTER_DEFAULTS, showLackRunes: false },
        },
      }),
    );
  });

  it('toggles the spell filters from the stored set, appending a category in click order', () => {
    stored = {
      spellbook: {
        hidden: {},
        order: {},
        activeCategories: ['combat'],
        filterOptions: { ...SPELL_FILTER_DEFAULTS, showLackRunes: false },
      },
    };
    const { result } = renderHook(() => usePanelFilters());

    act(() => {
      result.current.toggleSpellCategory('utility');
      result.current.toggleSpellCategory('teleport');
      result.current.toggleSpellFilterOption('showLackLevel');
    });

    expect(result.current.spellbookFilter.activeCategories).toEqual(['combat', 'utility', 'teleport']);
    expect(result.current.spellbookFilter.filterOptions).toEqual({
      ...SPELL_FILTER_DEFAULTS,
      showLackRunes: false,
      showLackLevel: false,
    });
  });

  // A key the model does not define does not merely sit there unread: it rides into the
  // replay presentation track, whose schema is exact. Repairing state alone would fix the
  // session; writing it back fixes the stored profile.
  it('writes back a profile it had to repair on load', () => {
    stored = {
      prayer: { hidden: [], order: null, filterOptions: { showLackLevel: false, notAFilter: true } },
      spellbook: {
        hidden: {},
        order: {},
        activeCategories: ['combat', 'teleport', 'utility'],
        filterOptions: { iconResizing: false, notAFilter: true },
      },
    };

    const { result } = renderHook(() => usePanelFilters());

    expect(result.current.prayerFilter.filterOptions.showLackLevel).toBe(false);
    expect(storageMocks.saveSetting).toHaveBeenCalledWith('osrs-panel-filters', {
      prayer: {
        hidden: [],
        order: null,
        filterOptions: { ...PRAYER_FILTER_DEFAULTS, showLackLevel: false },
        quickPrayerSelections: [],
      },
      spellbook: {
        hidden: {},
        order: {},
        activeCategories: ['combat', 'teleport', 'utility'],
        filterOptions: { ...SPELL_FILTER_DEFAULTS, iconResizing: false },
      },
    });
  });

  it('leaves a profile that needs no repair unwritten', () => {
    stored = {
      prayer: { hidden: [], order: null, filterOptions: PRAYER_FILTER_DEFAULTS, quickPrayerSelections: [] },
      spellbook: {
        hidden: {},
        order: {},
        activeCategories: ALL_SPELL_CATEGORIES,
        filterOptions: SPELL_FILTER_DEFAULTS,
      },
    };

    renderHook(() => usePanelFilters());

    expect(storageMocks.saveSetting).not.toHaveBeenCalled();
  });

  it('adds a selected quick prayer to the selections', () => {
    const { result } = renderHook(() => usePanelFilters());

    act(() => {
      result.current.toggleQuickPrayerSelection(PrayerType.ProtectMagic);
    });

    expect(result.current.quickPrayerSelections).toEqual([PrayerType.ProtectMagic]);
  });

  it('removes an already-selected quick prayer when toggled again', () => {
    const { result } = renderHook(() => usePanelFilters());

    act(() => {
      result.current.toggleQuickPrayerSelection(PrayerType.ProtectMagic);
      result.current.toggleQuickPrayerSelection(PrayerType.ProtectMagic);
    });

    expect(result.current.quickPrayerSelections).toEqual([]);
  });

  it('replaces a selected protection prayer with another protection prayer', () => {
    const { result } = renderHook(() => usePanelFilters());

    act(() => {
      result.current.toggleQuickPrayerSelection(PrayerType.ProtectMagic);
      result.current.toggleQuickPrayerSelection(PrayerType.ProtectRange);
    });

    expect(result.current.quickPrayerSelections).toEqual([PrayerType.ProtectRange]);
  });

  it('replaces a selected offensive prayer with another offensive prayer', () => {
    const { result } = renderHook(() => usePanelFilters());

    act(() => {
      result.current.toggleQuickPrayerSelection(PrayerType.Piety);
      result.current.toggleQuickPrayerSelection(PrayerType.Rigour);
    });

    expect(result.current.quickPrayerSelections).toEqual([PrayerType.Rigour]);
  });

  it('keeps prayers from different categories selected together', () => {
    const { result } = renderHook(() => usePanelFilters());

    act(() => {
      result.current.toggleQuickPrayerSelection(PrayerType.Piety);
      result.current.toggleQuickPrayerSelection(PrayerType.ProtectMagic);
    });

    expect(result.current.quickPrayerSelections).toEqual([PrayerType.Piety, PrayerType.ProtectMagic]);
  });

  it('keeps the three single-stat rows and an unconflicted prayer selected together', () => {
    const { result } = renderHook(() => usePanelFilters());

    act(() => {
      result.current.toggleQuickPrayerSelection(PrayerType.ThickSkin);
      result.current.toggleQuickPrayerSelection(PrayerType.BurstOfStrength);
      result.current.toggleQuickPrayerSelection(PrayerType.ClarityOfThought);
      result.current.toggleQuickPrayerSelection(PrayerType.Preserve);
    });

    expect(result.current.quickPrayerSelections).toEqual([
      PrayerType.ThickSkin,
      PrayerType.BurstOfStrength,
      PrayerType.ClarityOfThought,
      PrayerType.Preserve,
    ]);
  });

  it('deselects exactly what a new selection conflicts with', () => {
    const { result } = renderHook(() => usePanelFilters());

    act(() => {
      result.current.toggleQuickPrayerSelection(PrayerType.SteelSkin);
      result.current.toggleQuickPrayerSelection(PrayerType.UltimateStrength);
      result.current.toggleQuickPrayerSelection(PrayerType.IncredibleReflexes);
      result.current.toggleQuickPrayerSelection(PrayerType.Deadeye);
    });
    // Deadeye spans both offence rows but not the defence row.
    expect(result.current.quickPrayerSelections).toEqual([PrayerType.SteelSkin, PrayerType.Deadeye]);

    act(() => {
      result.current.toggleQuickPrayerSelection(PrayerType.Chivalry);
    });
    expect(result.current.quickPrayerSelections).toEqual([PrayerType.Chivalry]);
  });
});

const RECORDED_PANEL: ReplayPanelPresentation = {
  filters: {
    prayer: {
      hidden: ['Rapid Restore'],
      order: [PrayerType.Rigour, PrayerType.Piety],
      filterOptions: { showLowerTiers: false, showTieredOverMultiskill: false, showRapidHealing: false },
    },
    spellbook: {
      hidden: { standard: ['Wind Strike'] },
      order: { standard: null },
      activeCategories: ['combat'],
      filterOptions: { showLackRunes: false },
    },
  },
  modes: { prayerReordering: false, prayerFiltering: true, spellReordering: false, spellFiltering: false },
};

const POSITION = { x: 0, y: 0, anchorX: 'right', anchorY: 'bottom' } as const;

function makeReplayedPresentation(panelPresentation = RECORDED_PANEL): ReplayPresentationState {
  return {
    clientLayoutMode: 'modern',
    frame: { width: 1280, height: 720 },
    insets: { left: 0, right: 0 },
    uiScale: 1,
    panels: {
      gamePanel: POSITION,
      minimap: { ...POSITION, anchorY: 'top' },
      compactOrbs: { ...POSITION, anchorY: 'top', y: 60 },
      infobox: null,
      zukSetTimer: null,
    },
    variants: {
      activeGamePanelTab: 'prayer',
      compactOrbsEnabled: false,
      compactOrbsLayout: 'vertical',
      compactOrbsOrder: ['hitpoints', 'prayer', 'run', 'special'],
      infoboxPinTarget: 'inventory',
      showCoordinates: false,
      panelPresentation,
    },
  };
}

describe('usePanelFilters while a replay supplies the arrangement', () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ReplayPresentationProvider, {
      presentation: makeReplayedPresentation(),
      reportPanelPresentation: () => {},
      reportMinimapZoom: () => {},
      children,
    });

  beforeEach(() => {
    storageMocks.loadSetting.mockReset();
    storageMocks.saveSetting.mockReset();
    storageMocks.loadSetting.mockReturnValue({
      prayer: {
        hidden: [],
        order: null,
        filterOptions: PRAYER_FILTER_DEFAULTS,
        quickPrayerSelections: [PrayerType.Piety],
      },
      // Complete, so nothing here needs repairing on load: the subject is the replay
      // override, and a normalization write would blur the "never saves" assertions below.
      spellbook: {
        hidden: {},
        order: {},
        activeCategories: ALL_SPELL_CATEGORIES,
        filterOptions: SPELL_FILTER_DEFAULTS,
      },
    });
  });

  it('shows the recorded arrangement in place of the one the viewer saved', () => {
    const { result } = renderHook(() => usePanelFilters(), { wrapper });

    expect(result.current.prayerFilter.order).toEqual([PrayerType.Rigour, PrayerType.Piety]);
    expect(result.current.prayerFilter.hidden).toEqual(['Rapid Restore']);
    expect(result.current.spellbookFilter.hidden).toEqual({ standard: ['Wind Strike'] });
    expect(result.current.spellbookFilter.activeCategories).toEqual(['combat']);
    expect(result.current.spellbookFilter.filterOptions).toEqual({ ...SPELL_FILTER_DEFAULTS, showLackRunes: false });
  });

  it('plays back the arrangement a recorder reports exactly as the recorder saw it', () => {
    const recorder = renderHook(() => usePanelFilters());
    act(() => {
      recorder.result.current.togglePrayerFilterOption('showRapidHealing');
      recorder.result.current.toggleSpellHidden('ancient', 'Ice Barrage');
      recorder.result.current.toggleSpellCategory('teleport');
      recorder.result.current.toggleSpellFilterOption('iconResizing');
    });
    const reported: ReplayPanelPresentation = {
      filters: recorder.result.current.ownFilters,
      modes: RECORDED_PANEL.modes,
    };

    // Capture accepts only what the replay format's strict schema accepts.
    const captured = ReplayPresentationStateSchema.safeParse(makeReplayedPresentation(reported));
    expect(captured.success).toBe(true);
    const presentation = captured.data as ReplayPresentationState;
    const viewer = renderHook(() => usePanelFilters(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(ReplayPresentationProvider, {
          presentation,
          reportPanelPresentation: () => {},
          reportMinimapZoom: () => {},
          children,
        }),
    });

    const { quickPrayerSelections: _ownQuickPrayers, ...recordedPrayer } = recorder.result.current.prayerFilter;
    const { quickPrayerSelections: _viewerQuickPrayers, ...playedPrayer } = viewer.result.current.prayerFilter;
    expect(playedPrayer).toEqual(recordedPrayer);
    expect(viewer.result.current.spellbookFilter).toEqual(recorder.result.current.spellbookFilter);
    expect(viewer.result.current.spellbookFilter.activeCategories).toEqual(['combat', 'utility']);
  });

  // Quick prayers drive an engine action, not the panel's layout, so the recorder's
  // set must never reach the viewer's engine.
  it('leaves quick prayers set to whatever the viewer saved', () => {
    const { result } = renderHook(() => usePanelFilters(), { wrapper });

    expect(result.current.quickPrayerSelections).toEqual([PrayerType.Piety]);
  });

  it('ignores a reorder, which would apply the recorded slots to the saved list', () => {
    const { result } = renderHook(() => usePanelFilters(), { wrapper });

    act(() => {
      result.current.setPrayerOrder([PrayerType.Piety]);
      result.current.togglePrayerHidden('Protect from Magic');
    });

    expect(result.current.prayerFilter.order).toEqual([PrayerType.Rigour, PrayerType.Piety]);
    expect(storageMocks.saveSetting).not.toHaveBeenCalled();
  });

  // The loop-prevention invariant: report the override back and every replay would
  // seed the arrangement of the viewer's next recording.
  it('exposes the arrangement the viewer saved for reporting, not the override', () => {
    const { result } = renderHook(() => usePanelFilters(), { wrapper });

    expect(result.current.ownFilters.prayer.order).toBeNull();
    expect(result.current.ownFilters.prayer.hidden).toEqual([]);
    expect(result.current.ownFilters.spellbook.hidden).toEqual({});
  });
});
