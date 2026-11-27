import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SpellbookType } from '../components/GamePanel/SpellbookContent';
import { useReplayPanelPresentation } from '../contexts/ReplayPresentationContext';
import type { ReplayPanelFilters } from '../core/replayPresentation';
import type { PrayerFilterOptions, SpellCategory, SpellFilterOptions } from '../types/panelFilters';
import { PRAYER_FILTER_DEFAULTS, SPELL_FILTER_DEFAULTS } from '../types/panelFilters';
import { isPrayerType, prayersConflict } from '../types/simulation';
import { loadSetting, saveSetting } from '../util/storage';
import type { PanelFilterSettings, PrayerFilterSettings, SpellbookFilterSettings } from './panelFilterState';
import { normalizePanelFilterSettings, PANEL_FILTER_STORAGE_KEY } from './panelFilterState';

export type { PrayerFilterOptions, SpellFilterOptions };
export { PRAYER_FILTER_DEFAULTS, SPELL_FILTER_DEFAULTS };

/**
 * The canonical settings plus the serialized form of what storage actually held.
 *
 * The two differ exactly when normalizing repaired something, which is what the
 * persist effect keys off to write the repair back to localStorage.
 */
function readPanelFilterSettings(): { settings: PanelFilterSettings; storedJson: string } {
  const stored = loadSetting<unknown>(PANEL_FILTER_STORAGE_KEY);
  const settings = normalizePanelFilterSettings(stored);
  // Storage holding nothing is not a repair. Reporting the canonical form as already
  // persisted keeps a first-time profile from writing defaults nobody chose.
  return { settings, storedJson: JSON.stringify(stored ?? settings) };
}

/**
 * A replayed arrangement arrives readonly and every consumer down from here
 * mutates its arrays in place while reordering, so the override is copied out
 * rather than handed over.
 *
 * Both option records are spread over their defaults because the recorded rows
 * are optional (`ReplayPanelFilters`), and the panel needs a complete record to
 * render a row per filter.
 */
function toPrayerFilter(replayed: ReplayPanelFilters['prayer'], quickPrayerSelections: string[]): PrayerFilterSettings {
  return {
    hidden: [...replayed.hidden],
    order: replayed.order === null ? null : [...replayed.order],
    filterOptions: { ...PRAYER_FILTER_DEFAULTS, ...replayed.filterOptions },
    quickPrayerSelections,
  };
}

function toSpellbookFilter(replayed: ReplayPanelFilters['spellbook']): SpellbookFilterSettings {
  return {
    hidden: Object.fromEntries(Object.entries(replayed.hidden).map(([book, icons]) => [book, [...icons]])),
    order: Object.fromEntries(
      Object.entries(replayed.order).map(([book, order]) => [book, order === null ? null : [...order]]),
    ),
    activeCategories: [...replayed.activeCategories],
    filterOptions: { ...SPELL_FILTER_DEFAULTS, ...replayed.filterOptions },
  };
}

export function usePanelFilters() {
  const [initial] = useState(readPanelFilterSettings);
  const [settings, setSettings] = useState<PanelFilterSettings>(initial.settings);
  const persistedJsonRef = useRef(initial.storedJson);
  const replayFilters = useReplayPanelPresentation()?.filters ?? null;
  // Read by the setters below so they can stay identity-stable across a replay.
  const replayFiltersRef = useRef(replayFilters);
  replayFiltersRef.current = replayFilters;

  // Compares against what storage holds rather than skipping the first run: a load
  // that had to repair a stored value must write the repair back.
  useEffect(() => {
    const json = JSON.stringify(settings);
    if (json === persistedJsonRef.current) return;
    persistedJsonRef.current = json;
    saveSetting(PANEL_FILTER_STORAGE_KEY, settings);
  }, [settings]);

  const ownFilters = useMemo<ReplayPanelFilters>(
    () => ({
      prayer: {
        hidden: settings.prayer.hidden,
        order: settings.prayer.order,
        filterOptions: settings.prayer.filterOptions,
      },
      spellbook: settings.spellbook,
    }),
    [settings.prayer.hidden, settings.prayer.order, settings.prayer.filterOptions, settings.spellbook],
  );

  // `ownFilters` is the VIEWER's own arrangement, deliberately NOT the override:
  // `GamePanel` reports it upward, and reporting the override instead would write
  // the recorder's panel into the viewer's next recording, each replay inheriting
  // the one before it.

  const prayerFilter = useMemo(
    () =>
      replayFilters ? toPrayerFilter(replayFilters.prayer, settings.prayer.quickPrayerSelections) : settings.prayer,
    [replayFilters, settings.prayer],
  );
  const spellbookFilter = useMemo(
    () => (replayFilters ? toSpellbookFilter(replayFilters.spellbook) : settings.spellbook),
    [replayFilters, settings.spellbook],
  );

  // Every setter that writes a field the replay overrides is inert while one is
  // active: the icons on screen are the RECORDER's arrangement, so a reorder or a
  // hide there would apply the recorder's slots to the viewer's own saved list.

  const togglePrayerHidden = useCallback((icon: string) => {
    if (replayFiltersRef.current) return;
    setSettings((prev) => {
      const hidden = prev.prayer.hidden.includes(icon)
        ? prev.prayer.hidden.filter((h) => h !== icon)
        : [...prev.prayer.hidden, icon];
      return { ...prev, prayer: { ...prev.prayer, hidden } };
    });
  }, []);

  const setPrayerOrder = useCallback((order: string[] | null) => {
    if (replayFiltersRef.current) return;
    setSettings((prev) => ({ ...prev, prayer: { ...prev.prayer, order } }));
  }, []);

  const togglePrayerFilterOption = useCallback((key: keyof PrayerFilterOptions) => {
    if (replayFiltersRef.current) return;
    setSettings((prev) => ({
      ...prev,
      prayer: {
        ...prev.prayer,
        filterOptions: { ...prev.prayer.filterOptions, [key]: !prev.prayer.filterOptions[key] },
      },
    }));
  }, []);

  const toggleQuickPrayerSelection = useCallback((prayer: string) => {
    setSettings((prev) => {
      const current = prev.prayer.quickPrayerSelections;
      if (current.includes(prayer)) {
        return { ...prev, prayer: { ...prev.prayer, quickPrayerSelections: current.filter((p) => p !== prayer) } };
      }
      // Selecting a prayer deselects exactly what lighting it would turn off.
      const filtered = isPrayerType(prayer)
        ? current.filter((selected) => !isPrayerType(selected) || !prayersConflict(prayer, selected))
        : current;
      return { ...prev, prayer: { ...prev.prayer, quickPrayerSelections: [...filtered, prayer] } };
    });
  }, []);

  const toggleSpellHidden = useCallback((spellbook: SpellbookType, icon: string) => {
    if (replayFiltersRef.current) return;
    setSettings((prev) => {
      const currentHidden = prev.spellbook.hidden[spellbook] ?? [];
      const hidden = currentHidden.includes(icon) ? currentHidden.filter((h) => h !== icon) : [...currentHidden, icon];
      return {
        ...prev,
        spellbook: {
          ...prev.spellbook,
          hidden: { ...prev.spellbook.hidden, [spellbook]: hidden },
        },
      };
    });
  }, []);

  const setSpellOrder = useCallback((spellbook: SpellbookType, order: string[] | null) => {
    if (replayFiltersRef.current) return;
    setSettings((prev) => ({
      ...prev,
      spellbook: {
        ...prev.spellbook,
        order: { ...prev.spellbook.order, [spellbook]: order },
      },
    }));
  }, []);

  const toggleSpellCategory = useCallback((category: SpellCategory) => {
    if (replayFiltersRef.current) return;
    setSettings((prev) => {
      const current = prev.spellbook.activeCategories;
      const activeCategories = current.includes(category)
        ? current.filter((c) => c !== category)
        : [...current, category];
      return { ...prev, spellbook: { ...prev.spellbook, activeCategories } };
    });
  }, []);

  const toggleSpellFilterOption = useCallback((key: keyof SpellFilterOptions) => {
    if (replayFiltersRef.current) return;
    setSettings((prev) => ({
      ...prev,
      spellbook: {
        ...prev.spellbook,
        filterOptions: { ...prev.spellbook.filterOptions, [key]: !prev.spellbook.filterOptions[key] },
      },
    }));
  }, []);

  return {
    prayerFilter,
    ownFilters,
    quickPrayerSelections: settings.prayer.quickPrayerSelections,
    spellbookFilter,
    togglePrayerHidden,
    setPrayerOrder,
    togglePrayerFilterOption,
    toggleQuickPrayerSelection,
    toggleSpellHidden,
    setSpellOrder,
    toggleSpellCategory,
    toggleSpellFilterOption,
  };
}
