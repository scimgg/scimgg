// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react';
import type { SetStateAction } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CacheManager, type LocWithType } from '../../cache/CacheManager';
import { runModifierSelection } from '../../components/ModifiersModal';
import type { EncounterModifierSelection } from '../../core/encounters/encounterFactory';
import { SimulationEngine } from '../../core/SimulationEngine';
import { EQUIPMENT_PRESETS } from '../../data/playerPresets';
import { LobbyEncounter } from '../../encounters/lobby/LobbyEncounter';
import { encounterRegistry } from '../../encounters/registry';
import { createSimulationEngineFromRunConfig } from '../../encounters/simulationEngineFactory';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import { createEmptyInventory } from '../../types/inventory';
import { createDefaultStats } from '../../types/playerState';
import { DEFAULT_MECHANICS_CONFIG, type MechanicsConfig, PLAYER_MECHANICS_KEY } from '../../types/simulation';
import { log } from '../../util/Logger';
import { cloneInventory } from '../../util/loadoutUtils';
import { type EncounterManagerBindings, tutorialSetup, useEncounterManager } from '../useEncounterManager';

type UseEncounterManagerParams = Parameters<typeof useEncounterManager>[0];

function createCacheManagerMock(): CacheManager {
  const cacheManager = new CacheManager();
  vi.spyOn(cacheManager, 'loadMapLocs').mockResolvedValue([]);
  return cacheManager;
}

function createProps(overrides: Partial<UseEncounterManagerParams> = {}): UseEncounterManagerParams {
  const emptyInventory = createEmptyInventory();

  return {
    attackStylePerCategory: {},
    bindingsRef: { current: null },
    cacheManagerRef: { current: createCacheManagerMock() },
    getEncounterEquipment: () => ({}),
    getEncounterInventory: () => emptyInventory,
    getEncounterSupplies: () => createEmptyCombatSupplies(),
    isFullyLoaded: false,
    mechanicsConfigPerEncounter: {},
    modifiersPerEncounter: {},
    startingHpPerEncounter: {},
    objTypeLoader: null,
    playerStats: createDefaultStats(),
    setEncounterEquipment: vi.fn(),
    setEncounterInventory: vi.fn(),
    setEncounterSupplies: vi.fn(),
    updateMechanicsConfigPerEncounter: vi.fn(),
    updateModifiersPerEncounter: vi.fn(),
    updateStartingHpPerEncounter: vi.fn(),
    ...overrides,
  };
}

function enterAndCaptureEngine(
  kind: string,
  overrides: Partial<UseEncounterManagerParams> = {},
  modifiers?: EncounterModifierSelection,
  loadoutOverride?: Parameters<ReturnType<typeof useEncounterManager>['enterEncounter']>[1],
  mechanics?: Partial<MechanicsConfig>,
): SimulationEngine {
  const initialEngine = new SimulationEngine({ encounter: new LobbyEncounter() });
  const captured: { engine: SimulationEngine | null } = { engine: null };
  const bindings: EncounterManagerBindings = {
    engineRef: { current: initialEngine },
    playerEquipmentRef: { current: {} },
    playerInventoryRef: { current: createEmptyInventory() },
    playerCombatSuppliesRef: { current: createEmptyCombatSupplies() },
    replay: { resetReplay: vi.fn() },
    setEngine: (next) => {
      captured.engine = typeof next === 'function' ? next(initialEngine) : next;
    },
    setIsSceneReady: vi.fn(),
    setPlayerConfig: vi.fn(),
    setSimulationState: vi.fn(),
    setTargetTile: vi.fn(),
    simulationStateRef: { current: initialEngine.getState() },
    targetTileRef: { current: null },
  };
  const { result } = renderHook(useEncounterManager, {
    initialProps: createProps({ ...overrides, bindingsRef: { current: bindings } }),
  });

  act(() => {
    result.current.enterEncounter(kind, loadoutOverride, { modifiers, mechanics });
  });

  const engine = captured.engine;
  if (!engine) throw new Error('Expected enterEncounter to install a new engine');
  return engine;
}

describe('useEncounterManager', () => {
  it('proceeds without LOCs after a failed load, but waits for a fresh load on the next visit', async () => {
    vi.spyOn(log, 'error').mockImplementation(() => {});
    const yamaLocs = [{ location: { id: 1 } }] as unknown as LocWithType[];
    let resolveRetry: (locs: LocWithType[]) => void = () => {};
    const cacheManager = new CacheManager();
    vi.spyOn(cacheManager, 'loadMapLocs')
      .mockRejectedValueOnce(new Error('map square unreadable'))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRetry = resolve)));
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    const bindings: EncounterManagerBindings = {
      engineRef: { current: engine },
      playerEquipmentRef: { current: {} },
      playerInventoryRef: { current: createEmptyInventory() },
      playerCombatSuppliesRef: { current: createEmptyCombatSupplies() },
      replay: { resetReplay: vi.fn() },
      setEngine: vi.fn(),
      setIsSceneReady: vi.fn(),
      setPlayerConfig: vi.fn(),
      setSimulationState: vi.fn(),
      setTargetTile: vi.fn(),
      simulationStateRef: { current: engine.getState() },
      targetTileRef: { current: null },
    };
    const renders: [string | undefined, LocWithType[] | null][] = [];
    const { result } = renderHook(
      (props: UseEncounterManagerParams) => {
        const manager = useEncounterManager(props);
        renders.push([manager.encounterDescriptor?.kind, manager.mapLocs]);
        return manager;
      },
      {
        initialProps: createProps({
          bindingsRef: { current: bindings },
          cacheManagerRef: { current: cacheManager },
          isFullyLoaded: true,
        }),
      },
    );

    await act(async () => result.current.enterEncounter('yama_p3'));
    // This visit's failure: carry on with no LOCs rather than wait forever.
    expect(result.current.mapLocs).toEqual([]);

    // Back via the lobby, which loads no LOCs and so leaves nothing else in their place.
    await act(async () => result.current.enterLobby());
    renders.length = 0;
    await act(async () => result.current.enterEncounter('yama_p3'));
    expect(renders.filter(([kind]) => kind === 'yama_p3')).not.toHaveLength(0);
    expect(renders.every(([kind, locs]) => kind !== 'yama_p3' || locs === null)).toBe(true);

    await act(async () => resolveRetry(yamaLocs));
    expect(result.current.mapLocs).toBe(yamaLocs);
  });

  it("never hands a newly entered encounter the previous map square's LOCs", async () => {
    const yamaLocs = [{ location: { id: 1 } }] as unknown as LocWithType[];
    const solLocs = [{ location: { id: 2 } }] as unknown as LocWithType[];
    let resolveSolLocs: (locs: LocWithType[]) => void = () => {};
    const cacheManager = new CacheManager();
    vi.spyOn(cacheManager, 'loadMapLocs').mockImplementation((x) =>
      x === 23 ? Promise.resolve(yamaLocs) : new Promise((resolve) => (resolveSolLocs = resolve)),
    );
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    const bindings: EncounterManagerBindings = {
      engineRef: { current: engine },
      playerEquipmentRef: { current: {} },
      playerInventoryRef: { current: createEmptyInventory() },
      playerCombatSuppliesRef: { current: createEmptyCombatSupplies() },
      replay: { resetReplay: vi.fn() },
      setEngine: vi.fn(),
      setIsSceneReady: vi.fn(),
      setPlayerConfig: vi.fn(),
      setSimulationState: vi.fn(),
      setTargetTile: vi.fn(),
      simulationStateRef: { current: engine.getState() },
      targetTileRef: { current: null },
    };
    const renders: [string | undefined, LocWithType[] | null][] = [];
    const { result } = renderHook(
      (props: UseEncounterManagerParams) => {
        const manager = useEncounterManager(props);
        renders.push([manager.encounterDescriptor?.kind, manager.mapLocs]);
        return manager;
      },
      {
        initialProps: createProps({
          bindingsRef: { current: bindings },
          cacheManagerRef: { current: cacheManager },
          isFullyLoaded: true,
        }),
      },
    );

    await act(async () => result.current.enterEncounter('yama_p3'));
    expect(result.current.mapLocs).toBe(yamaLocs);

    renders.length = 0;
    await act(async () => result.current.enterEncounter('sol_heredit'));
    expect(renders.filter(([kind]) => kind === 'sol_heredit')).not.toHaveLength(0);
    expect(renders.every(([kind, locs]) => kind !== 'sol_heredit' || locs === null)).toBe(true);

    await act(async () => resolveSolLocs(solLocs));
    expect(result.current.mapLocs).toBe(solLocs);
  });

  it('uses descriptor modifiers for direct Enter without a selection', () => {
    const engine = enterAndCaptureEngine('sol_heredit');
    expect(engine.getRunConfig().bootstrap?.encounterConfig).toEqual({ modifiers: { blasphemy: 3 } });
  });

  it('keeps an explicit all-off selection instead of applying descriptor defaults', () => {
    const engine = enterAndCaptureEngine('sol_heredit', {}, {});
    expect(engine.getRunConfig().bootstrap?.encounterConfig).toBeUndefined();
  });

  describe('stored loadout on entry', () => {
    const preset = Object.values(EQUIPMENT_PRESETS.sol_heredit)[0];

    it.each([
      {},
      { weapon: preset.equipment.weapon },
    ])('keeps sparse equipment %j with a preset inventory', (equipment) => {
      const overrides = {
        getEncounterEquipment: () => ({ ...equipment }),
        getEncounterInventory: () => cloneInventory(preset.inventory),
        setEncounterEquipment: vi.fn(),
      };
      const engine = enterAndCaptureEngine('sol_heredit', overrides);

      expect(engine.playerEquipment).toEqual(equipment);
      expect(engine.getState().inventory).toEqual(preset.inventory);
      expect(overrides.setEncounterEquipment).not.toHaveBeenCalled();
    });

    it('uses an explicit sparse override ahead of stored gear without persisting it', () => {
      const overrides = {
        getEncounterEquipment: () => preset.equipment,
        getEncounterInventory: () => createEmptyInventory(),
        setEncounterEquipment: vi.fn(),
      };
      const loadout = {
        equipment: {},
        inventory: cloneInventory(preset.inventory),
        supplies: createEmptyCombatSupplies(),
      };
      const engine = enterAndCaptureEngine('sol_heredit', overrides, {}, loadout);

      expect(engine.playerEquipment).toEqual(loadout.equipment);
      expect(engine.getState().inventory).toEqual(loadout.inventory);
      expect(engine.getRunConfig().bootstrap?.encounterConfig).toBeUndefined();
      expect(overrides.setEncounterEquipment).not.toHaveBeenCalled();
    });
  });

  it('enters the retired zuk kind (the /zuk link) as the Inferno at wave 69 and saves that start', () => {
    const updateMechanicsConfigPerEncounter = vi.fn();
    const engine = enterAndCaptureEngine('zuk', {
      mechanicsConfigPerEncounter: { inferno: { infernoStartWave: '12', infiniteHealth: true } },
      updateMechanicsConfigPerEncounter,
    });

    expect(engine.getRunConfig().encounter.kind).toBe('inferno');
    expect(engine.getState().encounter).toMatchObject({ kind: 'inferno', state: { startWave: 69, wave: 69 } });
    // Saved as the Inferno's own start wave, so the canonical /inferno address reloads at wave 69.
    expect(updateMechanicsConfigPerEncounter).toHaveBeenCalledExactlyOnceWith({
      inferno: { infernoStartWave: '69', infiniteHealth: true },
    });
  });

  it('enters with an Inferno setup link’s mechanics, saved over the stored setup and started with', () => {
    const updateMechanicsConfigPerEncounter = vi.fn();
    const link = { infernoStartWave: '6', infernoSpawnLayout: '6:-b-l----b' };
    const engine = enterAndCaptureEngine(
      'inferno',
      {
        mechanicsConfigPerEncounter: { inferno: { infernoStartWave: '12', zukJad: false } },
        updateMechanicsConfigPerEncounter,
      },
      undefined,
      undefined,
      link,
    );
    expect(engine.getState().encounter).toMatchObject({
      kind: 'inferno',
      state: { startWave: 6, startSpawnLayout: '6:-b-l----b' },
    });
    expect(updateMechanicsConfigPerEncounter).toHaveBeenCalledExactlyOnceWith({
      inferno: { infernoStartWave: '6', zukJad: false, infernoSpawnLayout: '6:-b-l----b' },
    });
  });

  it('opens the configurer on given mechanics over the saved setup, never resetting the rest', () => {
    const updateMechanicsConfigPerEncounter = vi.fn();
    const saved = {
      inferno: { infernoStartWave: '12', zukJad: false, zukShieldSafeTiles: true },
      [PLAYER_MECHANICS_KEY]: { zealPrayer: true },
    };
    const { result } = renderHook(useEncounterManager, {
      initialProps: createProps({ mechanicsConfigPerEncounter: saved, updateMechanicsConfigPerEncounter }),
    });
    act(() => result.current.handleConfigureEncounter('inferno', 'The Inferno', 'desc', { infernoStartWave: '31' }));
    // Wave 69's aids and the account toggles stay as the player left them.
    expect(updateMechanicsConfigPerEncounter).toHaveBeenCalledExactlyOnceWith({
      ...saved,
      inferno: { infernoStartWave: '31', zukJad: false, zukShieldSafeTiles: true },
    });
    expect(result.current.selectedLobbyEncounter).toMatchObject({ encounterKind: 'inferno' });

    // A link that applies nothing still opens on the saved setup, not the defaults.
    updateMechanicsConfigPerEncounter.mockClear();
    act(() => result.current.setSelectedLobbyEncounter(null));
    act(() => result.current.handleConfigureEncounter('inferno', 'The Inferno', 'desc', {}));
    expect(updateMechanicsConfigPerEncounter).not.toHaveBeenCalled();
    expect(result.current.selectedLobbyEncounter).toMatchObject({ encounterKind: 'inferno' });
  });

  it('configures the Zuk statue by saving wave 69 over the saved Inferno setup, keeping the rest', () => {
    const updateMechanicsConfigPerEncounter = vi.fn();
    const saved = {
      inferno: { infernoStartWave: '12', zukJad: false, infernoSpawnLayout: '12:b--------' },
      [PLAYER_MECHANICS_KEY]: { zealPrayer: true },
    };
    const { result } = renderHook(useEncounterManager, {
      initialProps: createProps({ mechanicsConfigPerEncounter: saved, updateMechanicsConfigPerEncounter }),
    });
    act(() => result.current.handleConfigureEncounter('zuk', 'TzKal-Zuk', 'desc'));
    expect(updateMechanicsConfigPerEncounter).toHaveBeenCalledExactlyOnceWith({
      ...saved,
      inferno: { ...saved.inferno, infernoStartWave: '69' },
    });
    expect(result.current.selectedLobbyEncounter).toMatchObject({ encounterKind: 'inferno' });
  });

  describe('remembered modifiers', () => {
    const sol = (modifiersPerEncounter: Record<string, EncounterModifierSelection>) =>
      renderHook(useEncounterManager, { initialProps: createProps({ modifiersPerEncounter }) }).result;

    it('shows the descriptor default until a selection is saved, and a saved all-off selection as all off', () => {
      expect(sol({}).current.getSavedSetup('sol_heredit').modifiers).toEqual({ blasphemy: 3 });
      expect(sol({ sol_heredit: { doom: 2 } }).current.getSavedSetup('sol_heredit').modifiers).toEqual({ doom: 2 });
      expect(sol({ sol_heredit: {} }).current.getSavedSetup('sol_heredit').modifiers).toEqual({});
      // Tiers a modifier does not offer, and unknown modifiers, are dropped on read.
      expect(
        sol({ sol_heredit: { doom: 2, retired: 1 } as EncounterModifierSelection }).current.getSavedSetup('sol_heredit')
          .modifiers,
      ).toEqual({ doom: 2 });
      expect(encounterRegistry.getDescriptor('sol_heredit')?.defaultModifiers?.({})).toEqual({ blasphemy: 3 });
    });

    it('saves edits and keeps them through Configure, reopening it and an ordinary entry', () => {
      const updateModifiersPerEncounter = vi.fn();
      const { result, rerender } = renderHook(useEncounterManager, {
        initialProps: createProps({ updateModifiersPerEncounter }),
      });
      act(() => result.current.saveEncounterModifiers('sol_heredit', {}));
      expect(updateModifiersPerEncounter).toHaveBeenCalledExactlyOnceWith({ sol_heredit: {} });
      rerender(createProps({ modifiersPerEncounter: { sol_heredit: {} }, updateModifiersPerEncounter }));
      act(() => result.current.handleConfigureEncounter('sol_heredit', 'Sol Heredit', 'desc'));
      act(() => result.current.setSelectedLobbyEncounter(null));
      act(() => result.current.handleConfigureEncounter('sol_heredit', 'Sol Heredit', 'desc'));
      expect(result.current.getSavedSetup('sol_heredit').modifiers).toEqual({});
      expect(updateModifiersPerEncounter).toHaveBeenCalledOnce();
      const engine = enterAndCaptureEngine('sol_heredit', { modifiersPerEncounter: { sol_heredit: { doom: 2 } } });
      expect(engine.getRunConfig().bootstrap?.encounterConfig).toEqual({ modifiers: { doom: 2 } });
      const allOff = enterAndCaptureEngine('sol_heredit', { modifiersPerEncounter: { sol_heredit: {} } });
      expect(allOff.getRunConfig().bootstrap?.encounterConfig).toBeUndefined();
    });

    it("saves the Modifiers picker's restart selection as the encounter's", () => {
      const updateModifiersPerEncounter = vi.fn();
      enterAndCaptureEngine('sol_heredit', { updateModifiersPerEncounter }, { doom: 1 });
      expect(updateModifiersPerEncounter).toHaveBeenCalledExactlyOnceWith({ sol_heredit: { doom: 1 } });
    });
  });

  describe('reset to defaults', () => {
    const saved = {
      mechanicsConfigPerEncounter: {
        yama_p3_bloodied: { infiniteHealth: true },
        yama_p3: { infiniteHealth: true },
        [PLAYER_MECHANICS_KEY]: { zealPrayer: true },
      },
      modifiersPerEncounter: { yama_p3_bloodied: {}, sol_heredit: { doom: 2 } } as Record<
        string,
        EncounterModifierSelection
      >,
      startingHpPerEncounter: { yama_p3_bloodied: 25, yama_p3_glyphic: 40 },
    };

    it("resets one variant's mechanics, modifiers and starting hitpoints, and undoes exactly that", () => {
      const updates = {
        updateMechanicsConfigPerEncounter: vi.fn(),
        updateModifiersPerEncounter: vi.fn(),
        updateStartingHpPerEncounter: vi.fn(),
      };
      const { result, rerender } = renderHook(useEncounterManager, {
        initialProps: createProps({ ...saved, ...updates }),
      });
      expect(result.current.getSavedSetup('yama_p3_bloodied').isDefault).toBe(false);
      let undo: () => void = () => {};
      act(() => {
        undo = result.current.resetSavedSetup('yama_p3_bloodied');
      });
      // Siblings, other encounters and the account's unlocks stay.
      const mechanics = updates.updateMechanicsConfigPerEncounter.mock.calls[0]?.[0];
      expect(mechanics).toEqual({ yama_p3: { infiniteHealth: true }, [PLAYER_MECHANICS_KEY]: { zealPrayer: true } });
      const modifiers = updates.updateModifiersPerEncounter.mock.calls[0]?.[0];
      expect(modifiers).toEqual({ sol_heredit: { doom: 2 } });
      const startingHp = updates.updateStartingHpPerEncounter.mock.calls[0]?.[0];
      expect(startingHp).toEqual({ yama_p3_glyphic: 40 });
      // Saved, the variant reads as its defaults: Bloodied Blows' own 10 hitpoints.
      rerender(
        createProps({
          ...updates,
          mechanicsConfigPerEncounter: mechanics,
          modifiersPerEncounter: modifiers,
          startingHpPerEncounter: startingHp,
        }),
      );
      expect(result.current.getSavedSetup('yama_p3_bloodied')).toMatchObject({ isDefault: true, startingHp: 10 });

      // A later edit elsewhere survives the undo, which puts back only the three entries it replaced.
      const later = { ...mechanics, yama_p3: { infiniteHealth: false } };
      rerender(
        createProps({
          ...updates,
          mechanicsConfigPerEncounter: later,
          modifiersPerEncounter: modifiers,
          startingHpPerEncounter: startingHp,
        }),
      );
      for (const update of Object.values(updates)) update.mockClear();
      act(() => undo());
      expect(updates.updateMechanicsConfigPerEncounter).toHaveBeenCalledExactlyOnceWith({
        ...later,
        yama_p3_bloodied: { infiniteHealth: true },
      });
      expect(updates.updateModifiersPerEncounter).toHaveBeenCalledExactlyOnceWith(saved.modifiersPerEncounter);
      expect(updates.updateStartingHpPerEncounter).toHaveBeenCalledExactlyOnceWith(saved.startingHpPerEncounter);
    });

    it('counts account unlocks out of whether a setup is at its defaults', () => {
      const { result } = renderHook(useEncounterManager, {
        initialProps: createProps({
          mechanicsConfigPerEncounter: { [PLAYER_MECHANICS_KEY]: { zealPrayer: true, doubleDeathCharge: false } },
        }),
      });
      expect(result.current.getSavedSetup('yama_p3').isDefault).toBe(true);
      expect(result.current.getSavedSetup('sol_heredit').isDefault).toBe(true);
    });

    it('returns the Inferno to its default start, wave 69, and saves a chosen wave 1 as a choice', () => {
      const updateMechanicsConfigPerEncounter = vi.fn();
      const { result, rerender } = renderHook(useEncounterManager, {
        initialProps: createProps({
          mechanicsConfigPerEncounter: { inferno: { infernoStartWave: '1' } },
          updateMechanicsConfigPerEncounter,
        }),
      });
      expect(result.current.getSavedSetup('inferno')).toMatchObject({
        isDefault: false,
        mechanics: { infernoStartWave: '1' },
      });
      act(() => {
        result.current.resetSavedSetup('inferno');
      });
      const reset = updateMechanicsConfigPerEncounter.mock.calls[0]?.[0];
      expect(reset).toEqual({});
      rerender(createProps({ mechanicsConfigPerEncounter: reset, updateMechanicsConfigPerEncounter }));
      expect(result.current.getSavedSetup('inferno')).toMatchObject({
        isDefault: true,
        mechanics: { infernoStartWave: '69' },
      });

      // Saved as overrides of the defaults: wave 69 leaves nothing stored, wave 1 is kept.
      updateMechanicsConfigPerEncounter.mockClear();
      const defaults = result.current.getEncounterMergedMechanicsConfig('inferno');
      const storedStartWave = () => updateMechanicsConfigPerEncounter.mock.calls.at(-1)?.[0].inferno?.infernoStartWave;
      act(() => result.current.persistEncounterMechanicsConfig('inferno', { ...defaults, infernoStartWave: '1' }));
      expect(storedStartWave()).toBe('1');
      act(() => result.current.persistEncounterMechanicsConfig('inferno', defaults));
      expect(storedStartWave()).toBeUndefined();
    });
  });

  describe('tutorial setup', () => {
    const saved = {
      yama_p3: { yamaMageRange: false, infiniteSpecialAttack: true },
      [PLAYER_MECHANICS_KEY]: { zealPrayer: true },
    };

    it('plays the defaults, account unlocks, the lesson and Infinite Health, and saves none of it', () => {
      const updates = {
        updateMechanicsConfigPerEncounter: vi.fn(),
        updateModifiersPerEncounter: vi.fn(),
        updateStartingHpPerEncounter: vi.fn(),
        setEncounterSupplies: vi.fn(),
      };
      const preset = Object.values(EQUIPMENT_PRESETS.yama_p3)[0];
      const loadout = {
        equipment: preset.equipment,
        inventory: cloneInventory(preset.inventory),
        supplies: preset.supplies ?? createEmptyCombatSupplies(),
      };
      const initialEngine = new SimulationEngine({ encounter: new LobbyEncounter() });
      const captured: { engine: SimulationEngine | null } = { engine: null };
      const bindings: EncounterManagerBindings = {
        engineRef: { current: initialEngine },
        playerEquipmentRef: { current: {} },
        playerInventoryRef: { current: createEmptyInventory() },
        playerCombatSuppliesRef: { current: createEmptyCombatSupplies() },
        replay: { resetReplay: vi.fn() },
        setEngine: (next) => {
          captured.engine = typeof next === 'function' ? next(initialEngine) : next;
        },
        setIsSceneReady: vi.fn(),
        setPlayerConfig: vi.fn(),
        setSimulationState: vi.fn(),
        setTargetTile: vi.fn(),
        simulationStateRef: { current: initialEngine.getState() },
        targetTileRef: { current: null },
      };
      const { result } = renderHook(useEncounterManager, {
        initialProps: createProps({
          ...updates,
          bindingsRef: { current: bindings },
          mechanicsConfigPerEncounter: saved,
          startingHpPerEncounter: { yama_p3: 30 },
        }),
      });
      act(() => result.current.enterEncounter('yama_p3', undefined, { tutorial: tutorialSetup('yama_p3', loadout) }));
      expect(captured.engine?.playerEquipment).toEqual(preset.equipment);
      expect(captured.engine?.getState().mechanicsConfig).toMatchObject({
        yamaMageRange: true,
        infiniteSpecialAttack: false,
        infiniteHealth: true,
        zealPrayer: true,
      });
      expect(result.current.activeSetup).toMatchObject({ mode: 'tutorial', kind: 'yama_p3' });

      // A lesson's mechanics and Practice's edits stay in the tutorial setup; Infinite Health stays on.
      let applied: MechanicsConfig | null = null;
      act(() => {
        applied = result.current.updateTutorialSetup('yama_p3', { mechanics: { waves: false } });
      });
      expect(applied).toMatchObject({ waves: false, infiniteHealth: true });
      act(() =>
        result.current.handleMechanicsConfigChange({
          ...result.current.activeMechanicsConfig,
          fireballs: false,
          infiniteHealth: false,
          zealPrayer: false,
        }),
      );
      expect(result.current.activeMechanicsConfig).toMatchObject({
        waves: false,
        fireballs: false,
        infiniteHealth: true,
        zealPrayer: false,
      });
      // An autocast pick changes the lesson's gear, not the saved loadout.
      act(() => result.current.setActiveSetupSupplies('yama_p3', { ...loadout.supplies, selectedSpell: null }));
      expect(result.current.getActiveSetupLoadout('yama_p3').equipment).toEqual(preset.equipment);
      for (const update of Object.values(updates)) expect(update).not.toHaveBeenCalled();

      // Leaving it returns the scene to the saved setup, untouched.
      act(() => {
        expect(result.current.endTutorialSetup()).toMatchObject({ kind: 'yama_p3', loadout: expect.anything() });
      });
      expect(result.current.activeSetup.mode).toBe('saved');
      expect(result.current.activeMechanicsConfig).toMatchObject({
        yamaMageRange: false,
        infiniteSpecialAttack: true,
        zealPrayer: true,
      });
      expect(result.current.getActiveSetupLoadout('yama_p3').equipment).toEqual({});
    });

    it('starts afresh on Tutorial Mode entry, keeping a lesson preset already on the same kind', () => {
      const preset = Object.values(EQUIPMENT_PRESETS.yama_p3)[0];
      const loadout = {
        equipment: preset.equipment,
        inventory: preset.inventory,
        supplies: createEmptyCombatSupplies(),
      };
      const { result } = renderHook(useEncounterManager, { initialProps: createProps() });
      act(() => {
        result.current.updateTutorialSetup('yama_p3', { mechanics: { waves: false }, loadout });
      });
      let mechanics: MechanicsConfig | null = null;
      act(() => {
        mechanics = result.current.beginTutorialSetup('yama_p3');
      });
      expect(mechanics).toMatchObject({ infiniteHealth: true });
      expect(mechanics).not.toMatchObject({ waves: false });
      expect(result.current.getActiveSetupLoadout('yama_p3').equipment).toEqual(preset.equipment);
    });
  });

  it.each<EncounterModifierSelection>([
    {},
    { doom: 2 },
  ])('reconstructs recorded modifiers %j without using the open configurer or descriptor default', (modifiers) => {
    const recorded = enterAndCaptureEngine('sol_heredit', {}, modifiers).getRunConfig();
    const updateModifiersPerEncounter = vi.fn();
    const { result } = renderHook(useEncounterManager, {
      initialProps: createProps({
        modifiersPerEncounter: { sol_heredit: { frailty: 1 } },
        updateModifiersPerEncounter,
      }),
    });
    act(() => result.current.handleConfigureEncounter('sol_heredit', 'Sol Heredit', 'desc'));
    expect(result.current.getSavedSetup('sol_heredit').modifiers).toEqual({ frailty: 1 });
    const replayEngine = createSimulationEngineFromRunConfig(recorded, null);
    expect(replayEngine).not.toBeNull();
    expect(replayEngine?.getRunConfig().bootstrap?.encounterConfig).toEqual(recorded.bootstrap?.encounterConfig);
    expect(updateModifiersPerEncounter).not.toHaveBeenCalled();
  });

  it.each<[string, EncounterModifierSelection | undefined, EncounterModifierSelection]>([
    ['the descriptor default', undefined, { blasphemy: 3 }],
    ['an explicit selection', { doom: 2, bees: 1 }, { doom: 2, bees: 1 }],
    ['every modifier off', {}, {}],
  ])("restarts from the Modifiers picker on a run started with %s, carrying the picker's choice", (_, entered, read) => {
    const definitions = encounterRegistry.getDescriptorForKind('sol_heredit')?.modifiers;
    const running = enterAndCaptureEngine('sol_heredit', {}, entered);
    // The picker opens on the run's own selection...
    const current = runModifierSelection(running.getRunConfig().bootstrap?.encounterConfig, definitions);
    expect(current).toEqual(read);
    // ...and its restart is a fresh Enter of the same kind with the edited selection.
    const chosen = { ...current, frailty: 2 } as const;
    const restarted = enterAndCaptureEngine('sol_heredit', {}, chosen);
    expect(restarted).not.toBe(running);
    expect(restarted.getRunConfig().encounter.kind).toBe('sol_heredit');
    expect(runModifierSelection(restarted.getRunConfig().bootstrap?.encounterConfig, definitions)).toEqual(chosen);
  });

  it('resetEncounterMechanicsConfig removes persisted overrides for a base encounter kind', () => {
    const updateMechanicsConfigPerEncounter = vi.fn();
    const { result } = renderHook(useEncounterManager, {
      initialProps: createProps({
        mechanicsConfigPerEncounter: { yama_p3: { infiniteHealth: true } },
        updateMechanicsConfigPerEncounter,
      }),
    });

    act(() => {
      result.current.resetEncounterMechanicsConfig('yama_p3');
    });

    expect(updateMechanicsConfigPerEncounter).toHaveBeenCalledTimes(1);
    expect(updateMechanicsConfigPerEncounter).toHaveBeenCalledWith({});
  });

  it('resetEncounterMechanicsConfig clears the variant it was given and leaves its siblings alone', () => {
    const updateMechanicsConfigPerEncounter = vi.fn();
    const { result } = renderHook(useEncounterManager, {
      initialProps: createProps({
        mechanicsConfigPerEncounter: {
          yama_p3: { infiniteHealth: true },
          yama_p3_divine: { infiniteHealth: true },
          yama_p3_forfeit_breath: { infiniteStamina: true },
        },
        updateMechanicsConfigPerEncounter,
      }),
    });

    act(() => {
      result.current.resetEncounterMechanicsConfig('yama_p3_divine');
    });

    expect(updateMechanicsConfigPerEncounter).toHaveBeenCalledTimes(1);
    expect(updateMechanicsConfigPerEncounter).toHaveBeenCalledWith({
      yama_p3: { infiniteHealth: true },
      yama_p3_forfeit_breath: { infiniteStamina: true },
    });
  });

  it('resetEncounterMechanicsConfig no-ops when no overrides exist for the encounter', () => {
    const updateMechanicsConfigPerEncounter = vi.fn();
    const { result } = renderHook(useEncounterManager, {
      initialProps: createProps({
        mechanicsConfigPerEncounter: {},
        updateMechanicsConfigPerEncounter,
      }),
    });

    act(() => {
      result.current.resetEncounterMechanicsConfig('yama_p3');
    });

    expect(updateMechanicsConfigPerEncounter).not.toHaveBeenCalled();
  });

  it('handleConfigureEncounter opens the config panel on the saved setup, changing nothing', () => {
    const updateMechanicsConfigPerEncounter = vi.fn();
    const { result } = renderHook(useEncounterManager, {
      initialProps: createProps({
        mechanicsConfigPerEncounter: { yama_p3: { infiniteHealth: true } },
        updateMechanicsConfigPerEncounter,
      }),
    });

    act(() => {
      result.current.handleConfigureEncounter('yama_p3', 'Yama', 'desc');
    });

    expect(updateMechanicsConfigPerEncounter).not.toHaveBeenCalled();
    expect(result.current.getSavedSetup('yama_p3').mechanics.infiniteHealth).toBe(true);
    expect(result.current.selectedLobbyEncounter).not.toBeNull();
    expect(result.current.selectedLobbyEncounter).toMatchObject({
      encounterKind: 'yama_p3',
    });
  });

  it('applies vial smasher setting to new encounter engines before they are installed', () => {
    const initialEngine = new SimulationEngine({ encounter: new LobbyEncounter() });
    const captured: { engine: SimulationEngine | null } = { engine: null };
    const inventory = createEmptyInventory();
    inventory[0] = { id: 10931 };
    const setEngine = vi.fn((next: SetStateAction<SimulationEngine>) => {
      captured.engine = typeof next === 'function' ? next(initialEngine) : next;
    });
    const bindings: EncounterManagerBindings = {
      engineRef: { current: initialEngine },
      playerEquipmentRef: { current: {} },
      playerInventoryRef: { current: createEmptyInventory() },
      playerCombatSuppliesRef: { current: createEmptyCombatSupplies() },
      replay: { resetReplay: vi.fn() },
      setEngine,
      setIsSceneReady: vi.fn(),
      setPlayerConfig: vi.fn(),
      setSimulationState: vi.fn(),
      setTargetTile: vi.fn(),
      simulationStateRef: { current: initialEngine.getState() },
      targetTileRef: { current: null },
    };

    const { result } = renderHook(useEncounterManager, {
      initialProps: createProps({
        bindingsRef: { current: bindings },
        getEncounterInventory: () => inventory,
      }),
    });

    act(() => {
      result.current.enterEncounter('yama_p3');
    });

    const nextEngine = captured.engine;
    if (!nextEngine) throw new Error('Expected enterEncounter to install a new engine');
    nextEngine.completeIntro();
    nextEngine.setMechanicsConfig({ yamaMageRange: false, waves: false, fireballs: false, infiniteHealth: true });
    nextEngine.applyAction({ type: 'itemAction', inventoryIndex: 0 });
    nextEngine.advanceTick(nextEngine.getState().playerPosition);

    expect(nextEngine.getState().inventory[0]).toBeNull();
  });

  it('applies configured player stats to newly installed encounter engines', () => {
    const initialEngine = new SimulationEngine({ encounter: new LobbyEncounter() });
    const captured: { engine: SimulationEngine | null } = { engine: null };
    const bindings: EncounterManagerBindings = {
      engineRef: { current: initialEngine },
      playerEquipmentRef: { current: {} },
      playerInventoryRef: { current: createEmptyInventory() },
      playerCombatSuppliesRef: { current: createEmptyCombatSupplies() },
      replay: { resetReplay: vi.fn() },
      setEngine: (next) => {
        captured.engine = typeof next === 'function' ? next(initialEngine) : next;
      },
      setIsSceneReady: vi.fn(),
      setPlayerConfig: vi.fn(),
      setSimulationState: vi.fn(),
      setTargetTile: vi.fn(),
      simulationStateRef: { current: initialEngine.getState() },
      targetTileRef: { current: null },
    };
    const playerStats = createDefaultStats();
    playerStats.magic = { current: 75, max: 75 };
    playerStats.hitpoints = { current: 80, max: 80 };

    const { result } = renderHook(useEncounterManager, {
      initialProps: createProps({ bindingsRef: { current: bindings }, playerStats }),
    });

    act(() => {
      result.current.enterEncounter('yama_p3');
    });

    expect(captured.engine?.getState()).toMatchObject({ stats: playerStats, playerHP: 80, maxHP: 80 });
  });

  describe('starting hitpoints', () => {
    it('uses the Bloodied Blows declared default', () => {
      const engine = enterAndCaptureEngine('yama_p3_bloodied');

      expect(engine.getState().playerHP).toBe(10);
    });

    it('prefers the saved Bloodied Blows override', () => {
      const engine = enterAndCaptureEngine('yama_p3_bloodied', {
        startingHpPerEncounter: { yama_p3_bloodied: 25 },
      });

      expect(engine.getState().playerHP).toBe(25);
    });

    it('opens a variant without a starting-hitpoints declaration at full health', () => {
      const engine = enterAndCaptureEngine('yama_p3');

      const state = engine.getState();
      expect(state.playerHP).toBe(state.maxHP);
    });
  });

  it('installs the encounter starting supplies onto the new engine when entering', () => {
    const startingSupplies = {
      equippedAmmo: { id: 28991, quantity: 3799 },
      quiverAmmo: { id: 9242, quantity: 807 },
      runePouch: null,
      blowpipe: null,
      selectedSpell: null,
      spellbook: 'arceuus' as const,
    } as const;
    const initialEngine = new SimulationEngine({ encounter: new LobbyEncounter() });
    const captured: { engine: SimulationEngine | null } = { engine: null };
    const bindings: EncounterManagerBindings = {
      engineRef: { current: initialEngine },
      playerEquipmentRef: { current: {} },
      playerInventoryRef: { current: createEmptyInventory() },
      playerCombatSuppliesRef: { current: createEmptyCombatSupplies() },
      replay: { resetReplay: vi.fn() },
      setEngine: (next) => {
        captured.engine = typeof next === 'function' ? next(initialEngine) : next;
      },
      setIsSceneReady: vi.fn(),
      setPlayerConfig: vi.fn(),
      setSimulationState: vi.fn(),
      setTargetTile: vi.fn(),
      simulationStateRef: { current: initialEngine.getState() },
      targetTileRef: { current: null },
    };

    const { result } = renderHook(useEncounterManager, {
      initialProps: createProps({
        bindingsRef: { current: bindings },
        getEncounterSupplies: () => ({ ...startingSupplies }),
      }),
    });

    act(() => {
      result.current.enterEncounter('yama_p3');
    });

    expect(captured.engine?.getCombatSupplies()).toEqual(startingSupplies);
    expect(bindings.playerCombatSuppliesRef.current).toEqual(startingSupplies);
  });

  /**
   * The rite of vile transference is an ACCOUNT unlock, and Death Charge is castable anywhere.
   * The store is keyed by encounter, so writing it beside a boss's own toggles would switch it
   * off at Yama and leave it on everywhere else.
   */
  describe('account-wide player toggles', () => {
    it('persists Zeal separately and applies its unlock across encounters', () => {
      const updateMechanicsConfigPerEncounter = vi.fn();
      const { result, rerender } = renderHook(useEncounterManager, {
        initialProps: createProps({ mechanicsConfigPerEncounter: {}, updateMechanicsConfigPerEncounter }),
      });
      expect(result.current.getEncounterMergedMechanicsConfig('yama_p3').zealPrayer).toBe(false);
      act(() => {
        result.current.persistEncounterMechanicsConfig('yama_p3', {
          ...result.current.getEncounterMergedMechanicsConfig('yama_p3'),
          zealPrayer: true,
        });
      });
      const saved = updateMechanicsConfigPerEncounter.mock.calls[0]?.[0];
      expect(saved[PLAYER_MECHANICS_KEY]).toEqual({ zealPrayer: true });
      expect(saved.yama_p3).not.toHaveProperty('zealPrayer');
      rerender(createProps({ mechanicsConfigPerEncounter: saved, updateMechanicsConfigPerEncounter }));
      expect(result.current.getEncounterMergedMechanicsConfig('lobby')).toMatchObject({
        zealPrayer: true,
        upgradedPrayers: true,
      });
    });

    it('persists under the shared player key, not the encounter being configured', () => {
      const updateMechanicsConfigPerEncounter = vi.fn();
      const { result } = renderHook(useEncounterManager, {
        initialProps: createProps({ mechanicsConfigPerEncounter: {}, updateMechanicsConfigPerEncounter }),
      });

      act(() => {
        // What the settings panel hands back: the encounter's merged config with a toggle flipped.
        result.current.persistEncounterMechanicsConfig('yama_p3', {
          ...result.current.getEncounterMergedMechanicsConfig('yama_p3'),
          doubleDeathCharge: false,
          infiniteHealth: true,
        });
      });

      const saved = updateMechanicsConfigPerEncounter.mock.calls[0]?.[0];
      expect(saved[PLAYER_MECHANICS_KEY]).toEqual({ doubleDeathCharge: false });
      expect(saved.yama_p3).not.toHaveProperty('doubleDeathCharge');
      expect(saved.yama_p3).toMatchObject({ infiniteHealth: true });
    });

    it('drops the override once the toggle returns to its global default', () => {
      const updateMechanicsConfigPerEncounter = vi.fn();
      const { result } = renderHook(useEncounterManager, {
        initialProps: createProps({
          mechanicsConfigPerEncounter: { [PLAYER_MECHANICS_KEY]: { doubleDeathCharge: false } },
          updateMechanicsConfigPerEncounter,
        }),
      });

      act(() => {
        result.current.persistEncounterMechanicsConfig('yama_p3', {
          ...result.current.getEncounterMergedMechanicsConfig('yama_p3'),
          doubleDeathCharge: DEFAULT_MECHANICS_CONFIG.doubleDeathCharge,
        });
      });

      const saved = updateMechanicsConfigPerEncounter.mock.calls[0]?.[0];
      expect(saved).not.toHaveProperty(PLAYER_MECHANICS_KEY);
    });

    it('reaches an encounter that never declared the toggle', () => {
      const { result } = renderHook(useEncounterManager, {
        initialProps: createProps({
          mechanicsConfigPerEncounter: { [PLAYER_MECHANICS_KEY]: { doubleDeathCharge: false } },
        }),
      });

      expect(result.current.getEncounterMergedMechanicsConfig('lobby').doubleDeathCharge).toBe(false);
      expect(result.current.getEncounterMergedMechanicsConfig('yama_p3').doubleDeathCharge).toBe(false);
    });
  });
});
