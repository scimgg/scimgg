// @vitest-environment happy-dom

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheManager } from '../../../cache/CacheManager';
import { EncounterPanel } from '../../../components/EncounterPanel';
import { runModifierSelection } from '../../../components/ModifiersModal';
import type { EncounterModifierSelection } from '../../../core/encounters/encounterFactory';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { type EncounterManagerBindings, useEncounterManager } from '../../../hooks/useEncounterManager';
import { PERSISTED_SETTINGS_KEY, usePersistedSettings } from '../../../hooks/usePersistedSettings';
import { createEmptyCombatSupplies } from '../../../types/encounterLoadout';
import { createEmptyInventory } from '../../../types/inventory';
import { DEFAULT_PLAYER_CONFIG } from '../../../types/player';
import { createDefaultStats } from '../../../types/playerState';
import { deleteSetting } from '../../../util/storage';
import { LobbyEncounter } from '../../lobby/LobbyEncounter';
import { buildSolHereditControls } from '../../solHeredit/controls';
import { SOL_HEREDIT_MODIFIERS } from '../../solHeredit/modifiers';

const KIND = 'sol_heredit';

/** Just enough of the wiring for an entry to install its engine where the test can read it. */
function createBindings(): EncounterManagerBindings {
  const engineRef = { current: new SimulationEngine({ encounter: new LobbyEncounter() }) };
  return {
    engineRef,
    playerEquipmentRef: { current: {} },
    playerInventoryRef: { current: createEmptyInventory() },
    playerCombatSuppliesRef: { current: createEmptyCombatSupplies() },
    replay: { resetReplay: vi.fn() },
    setEngine: (next) => {
      engineRef.current = typeof next === 'function' ? next(engineRef.current) : next;
    },
    setIsSceneReady: vi.fn(),
    setPlayerConfig: vi.fn(),
    setSimulationState: vi.fn(),
    setTargetTile: vi.fn(),
    simulationStateRef: { current: engineRef.current.getState() },
    targetTileRef: { current: null },
  };
}

/** useEncounterManager over the real persisted settings, as App holds them. */
function useSavedSetup(bindings: EncounterManagerBindings | null = null) {
  const [settings, updateSetting] = usePersistedSettings();
  const manager = useEncounterManager({
    attackStylePerCategory: {},
    bindingsRef: { current: bindings },
    cacheManagerRef: { current: new CacheManager() },
    getEncounterEquipment: () => ({}),
    getEncounterInventory: () => createEmptyInventory(),
    getEncounterSupplies: () => createEmptyCombatSupplies(),
    isFullyLoaded: false,
    mechanicsConfigPerEncounter: settings.mechanicsConfigPerEncounter,
    modifiersPerEncounter: settings.modifiersPerEncounter,
    startingHpPerEncounter: {},
    objTypeLoader: null,
    playerStats: createDefaultStats(),
    setEncounterEquipment: vi.fn(),
    setEncounterInventory: vi.fn(),
    setEncounterSupplies: vi.fn(),
    updateMechanicsConfigPerEncounter: (next) => updateSetting('mechanicsConfigPerEncounter', next),
    updateModifiersPerEncounter: (next) => updateSetting('modifiersPerEncounter', next),
    updateStartingHpPerEncounter: vi.fn(),
  });
  return { manager, modifiersPerEncounter: settings.modifiersPerEncounter };
}

function renderSetup() {
  const bindings = createBindings();
  let view = renderHook(() => useSavedSetup(bindings));
  const current = () => view.result.current;
  const setWave = (wave: number) =>
    act(() => {
      const mechanics = current().manager.getSavedSetup(KIND).mechanics;
      current().manager.persistEncounterMechanicsConfig(KIND, { ...mechanics, colosseumStartWave: String(wave) });
    });
  const edit = (selection: EncounterModifierSelection) =>
    act(() => current().manager.saveEncounterModifiers(KIND, selection));
  const reset = () => act(() => current().manager.resetEncounterModifiers(KIND));
  const modifiers = () => current().manager.getSavedSetup(KIND).modifiers;
  const saved = () => current().manager.getSavedSetup(KIND).modifiersSaved;
  const reload = () => {
    view.unmount();
    view = renderHook(() => useSavedSetup(bindings));
  };
  const enter = () => act(() => current().manager.enterEncounter(KIND));
  /** The in-fight Modifiers picker's Restart, opened on the running fight's set as App opens it. */
  const pickerRestart = (edit?: (shown: EncounterModifierSelection) => EncounterModifierSelection) =>
    act(() => {
      const shown = runModifierSelection(
        bindings.engineRef.current.getRunConfig().bootstrap?.encounterConfig,
        SOL_HEREDIT_MODIFIERS,
      );
      current().manager.enterEncounter(KIND, undefined, { modifiers: edit ? edit(shown) : shown });
    });
  const runModifiers = () => bindings.engineRef.current.getRunConfig().bootstrap?.encounterConfig;
  return { current, setWave, edit, reset, modifiers, saved, reload, enter, pickerRestart, runModifiers };
}

describe('the Colosseum modifier set across start waves', () => {
  afterEach(() => deleteSetting(PERSISTED_SETTINGS_KEY));

  it('suggests Blasphemy at the tier a run would hold by each start wave while nothing is saved', () => {
    const { setWave, modifiers, saved } = renderSetup();
    // Untouched wave 12 is today's direct Sol default.
    expect(modifiers()).toEqual({ blasphemy: 3 });
    const expected: [number, EncounterModifierSelection][] = [
      [1, {}],
      [2, { blasphemy: 1 }],
      [3, { blasphemy: 2 }],
      [5, { blasphemy: 2 }],
      [6, { blasphemy: 3 }],
      [11, { blasphemy: 3 }],
      [12, { blasphemy: 3 }],
    ];
    for (const [wave, selection] of expected) {
      setWave(wave);
      expect(modifiers()).toEqual(selection);
    }
    expect(saved()).toBe(false);
  });

  it('keeps an edit exactly as made when the start wave changes, Blasphemy turned off included', () => {
    const { current, setWave, edit, modifiers } = renderSetup();
    setWave(4);
    edit({ doom: 1 });
    expect(current().modifiersPerEncounter[KIND]).toEqual({ doom: 1 });
    for (const wave of [1, 2, 9, 12]) {
      setWave(wave);
      expect(modifiers()).toEqual({ doom: 1 });
    }
    setWave(3);
    edit({ blasphemy: 3 });
    setWave(4);
    expect(modifiers()).toEqual({ blasphemy: 3 });
  });

  it('keeps an edit back to the current default explicit across a wave change and a reload', () => {
    const { setWave, edit, reset, modifiers, saved, reload } = renderSetup();
    // Doom on, then off again, at wave 1: the set is back to wave 1's none, but it is the player's.
    setWave(1);
    edit({ doom: 1 });
    edit({});
    expect(saved()).toBe(true);
    setWave(6);
    expect(modifiers()).toEqual({});
    reload();
    expect(modifiers()).toEqual({});
    expect(saved()).toBe(true);
    // The same at a later wave, with its own default chosen by hand.
    setWave(8);
    edit({ blasphemy: 3 });
    setWave(2);
    expect(modifiers()).toEqual({ blasphemy: 3 });
    reload();
    expect(modifiers()).toEqual({ blasphemy: 3 });
    // Reset alone lets it follow the waves again.
    reset();
    expect(saved()).toBe(false);
    expect(modifiers()).toEqual({ blasphemy: 1 });
    setWave(1);
    expect(modifiers()).toEqual({});
  });

  it("saves nothing for the Modifiers picker's Restart of an untouched set, which goes on following the wave", () => {
    const { current, setWave, modifiers, saved, enter, pickerRestart, runModifiers } = renderSetup();
    setWave(4);
    enter();
    expect(runModifiers()).toEqual({ modifiers: { blasphemy: 2 } });
    pickerRestart();
    expect(saved()).toBe(false);
    expect(current().modifiersPerEncounter).not.toHaveProperty(KIND);
    expect(runModifiers()).toEqual({ modifiers: { blasphemy: 2 } });
    setWave(1);
    expect(modifiers()).toEqual({});
    enter();
    expect(runModifiers()).toBeUndefined();
    setWave(9);
    expect(modifiers()).toEqual({ blasphemy: 3 });
    enter();
    // A change in the picker is an edit like any other, and is saved.
    pickerRestart((shown) => ({ ...shown, doom: 1 }));
    expect(saved()).toBe(true);
    expect(current().modifiersPerEncounter[KIND]).toEqual({ blasphemy: 3, doom: 1 });
  });

  it("keeps a saved set saved through the Modifiers picker's Restart, unchanged or equal to the default", () => {
    const { current, setWave, edit, modifiers, saved, enter, pickerRestart, runModifiers } = renderSetup();
    setWave(6);
    edit({ blasphemy: 3 });
    enter();
    pickerRestart();
    expect(saved()).toBe(true);
    expect(current().modifiersPerEncounter[KIND]).toEqual({ blasphemy: 3 });
    expect(runModifiers()).toEqual({ modifiers: { blasphemy: 3 } });
    setWave(1);
    expect(modifiers()).toEqual({ blasphemy: 3 });
    // Restarted into the default of no modifiers, the set is still the player's.
    pickerRestart(() => ({}));
    expect(saved()).toBe(true);
    expect(current().modifiersPerEncounter[KIND]).toEqual({});
    setWave(12);
    expect(modifiers()).toEqual({});
  });

  it('reads a set saved before the waves as the default only when it is the old Blasphemy III', () => {
    localStorage.setItem(
      PERSISTED_SETTINGS_KEY,
      JSON.stringify({ modifiersPerEncounter: { [KIND]: { blasphemy: 3 } } }),
    );
    const legacy = renderSetup();
    expect(legacy.saved()).toBe(false);
    legacy.setWave(4);
    expect(legacy.modifiers()).toEqual({ blasphemy: 2 });
    legacy.reload();
    expect(legacy.modifiers()).toEqual({ blasphemy: 2 });
    deleteSetting(PERSISTED_SETTINGS_KEY);

    localStorage.setItem(
      PERSISTED_SETTINGS_KEY,
      JSON.stringify({ modifiersPerEncounter: { [KIND]: { blasphemy: 3, doom: 2 } } }),
    );
    const edited = renderSetup();
    edited.setWave(4);
    expect(edited.modifiers()).toEqual({ blasphemy: 3, doom: 2 });
  });
});

describe('the configurer reset action', () => {
  function renderPanel(
    modifierSelection: EncounterModifierSelection,
    startWave: string,
    { withToggles = false, saved = false } = {},
  ) {
    const onModifierSelectionChange = vi.fn();
    const onModifierSelectionReset = vi.fn();
    render(
      <EncounterPanel
        encounterKind={KIND}
        displayName="Fortis Colosseum"
        description=""
        isAvailable
        playerConfig={DEFAULT_PLAYER_CONFIG}
        encounterEquipment={{}}
        onEquipmentChange={vi.fn()}
        onInventoryChange={vi.fn()}
        onStatsChange={vi.fn()}
        mechanicsConfig={{ infiniteHealth: false, colosseumStartWave: startWave }}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={withToggles ? buildSolHereditControls().mechanicsToggles : []}
        modifiers={SOL_HEREDIT_MODIFIERS}
        modifierSelection={modifierSelection}
        onModifierSelectionChange={onModifierSelectionChange}
        onModifierSelectionReset={saved ? onModifierSelectionReset : undefined}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    return { onModifierSelectionChange, onModifierSelectionReset };
  }

  it('offers the reset in the editor for a saved set, which drops it rather than saving the default', () => {
    const { onModifierSelectionChange, onModifierSelectionReset } = renderPanel({ doom: 1 }, '8', { saved: true });
    expect(screen.getByRole('heading', { name: /^Modifiers going into wave 8/ })).toBeTruthy();
    // The rail keeps one reset, the column's own; the set's own reset is in its editor.
    expect(screen.queryByRole('button', { name: /Reset to wave/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details & edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to wave 8 default' }));
    expect(onModifierSelectionReset).toHaveBeenCalledOnce();
    expect(onModifierSelectionChange).not.toHaveBeenCalled();
  });

  it('offers the reset for a saved set equal to the default, which would otherwise not follow the wave', () => {
    const { onModifierSelectionReset } = renderPanel({ blasphemy: 3 }, '8', { saved: true });
    fireEvent.click(screen.getByRole('button', { name: 'Details & edit' }));
    const reset = screen.getByRole('button', { name: 'Reset to wave 8 default' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(onModifierSelectionReset).toHaveBeenCalledOnce();
  });

  it('shows no reset while the set is the default, and the footer names the waves and the set', () => {
    renderPanel({ blasphemy: 2 }, '4');
    fireEvent.click(screen.getByRole('button', { name: 'Details & edit' }));
    expect(screen.queryByRole('button', { name: /Reset to wave/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Return to setup' }));
    expect(document.querySelector('.configurer-start-summary strong')?.textContent).toBe('Waves 4–12 · 1 modifier');
  });

  it('leads with the start wave, then the set it names, then Sol Heredit grouped as the Inferno groups Zuk', () => {
    renderPanel({ blasphemy: 2 }, '4', { withToggles: true });
    const rail = document.querySelector('.encounter-panel-rail') as HTMLElement;
    const order = [...rail.querySelectorAll('.colosseum-setup, .configurer-modifiers, h3.section-label')].map((node) =>
      node.classList.contains('colosseum-setup')
        ? 'start wave'
        : node.classList.contains('configurer-modifiers')
          ? 'modifiers'
          : node.textContent,
    );
    expect(order).toEqual(['Wave & modifiers', 'start wave', 'modifiers', 'Preparation', 'Sol Heredit']);
    // Deferred until the run reaches him, as TzKal-Zuk's controls say "From wave 69".
    expect(screen.getByText('From wave 12')).toBeTruthy();
  });

  it('keeps a direct Sol start the same fight, with no deferral note', () => {
    renderPanel({ blasphemy: 3 }, '12', { withToggles: true });
    expect(screen.getByRole('heading', { name: 'Sol Heredit' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Sol Attacks' })).toBeTruthy();
    expect(screen.queryByText('From wave 12')).toBeNull();
  });
});
