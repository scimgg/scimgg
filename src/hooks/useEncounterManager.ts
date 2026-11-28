import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CacheManager, LocWithType } from '../cache/CacheManager';
import { toCollisionLocInput } from '../core/arena/collisionSpec';
import { setResolvedArenaConfig } from '../core/constants';
import { type EncounterModifierSelection, filterModifierSelection } from '../core/encounters/encounterFactory';
import { resolveEncounterPresetsKey, resolveStartingHitpoints } from '../core/encounters/variantTypes';
import type { SimulationEngine } from '../core/SimulationEngine';
import { LOBBY_NPC_ENCOUNTERS, type LobbyEncounterCard } from '../encounters/lobby/metadata';
import { encounterControlsForKind, encounterEnablesIntro, resolveEncounterEntry } from '../encounters/modules';
import { encounterRegistry } from '../encounters/registry';
import { createSimulationEngineForNewRun } from '../encounters/simulationEngineFactory';
import type { ObjTypeLoader } from '../rs/config/objtype/ObjTypeLoader';
import type { PlayerEquipment } from '../rs/model/PlayerModelLoader';
import {
  type CombatSupplies,
  cloneCombatSupplies,
  createEmptyCombatSupplies,
  type EncounterLoadout,
} from '../types/encounterLoadout';
import { createEmptyInventory, type Inventory } from '../types/inventory';
import type { PlayerConfig } from '../types/player';
import type { PlayerStats } from '../types/playerState';
import type { SetupMode } from '../types/setupContext';
import {
  type Coordinate,
  DEFAULT_MECHANICS_CONFIG,
  type MechanicsConfig,
  mergeMechanicsConfig,
  PLAYER_MECHANICS_KEY,
  PLAYER_MECHANICS_TOGGLE_KEYS,
  type SimulationState,
} from '../types/simulation';
import { log } from '../util/Logger';
import { cloneEquipment, cloneInventory } from '../util/loadoutUtils';
import type { UseReplayReturn } from './useReplay';
import type { SceneState } from './useSimulationWiring';

export interface EncounterManagerBindings {
  engineRef: MutableRefObject<SimulationEngine>;
  playerEquipmentRef: MutableRefObject<PlayerEquipment>;
  playerInventoryRef: MutableRefObject<Inventory>;
  playerCombatSuppliesRef: MutableRefObject<CombatSupplies>;
  replay: Pick<UseReplayReturn, 'resetReplay'>;
  setEngine: Dispatch<SetStateAction<SimulationEngine>>;
  setIsSceneReady: Dispatch<SetStateAction<boolean>>;
  setPlayerConfig: Dispatch<SetStateAction<PlayerConfig>>;
  setSimulationState: Dispatch<SetStateAction<SimulationState>>;
  setTargetTile: Dispatch<SetStateAction<Coordinate | null>>;
  simulationStateRef: MutableRefObject<SimulationState>;
  targetTileRef: MutableRefObject<Coordinate | null>;
}

/**
 * Tutorial Mode's own setup for one encounter/variant: the encounter's defaults, the account's
 * unlocks, the lesson's mechanics over them and forced Infinite Health, played in the lesson's gear
 * when it has some. Nothing in it is ever saved, so leaving a tutorial restores nothing.
 */
export interface TutorialSetup {
  /** The exact encounter/variant kind it is for. */
  readonly kind: string;
  readonly mechanics: Readonly<Partial<MechanicsConfig>>;
  /** The lesson's preset gear; absent plays the saved loadout. */
  readonly loadout?: EncounterLoadout;
}

/** A fresh tutorial setup for `kind`. */
export function tutorialSetup(kind: string, loadout?: EncounterLoadout): TutorialSetup {
  return { kind, mechanics: {}, ...(loadout ? { loadout } : {}) };
}

/** What a surface shows for one encounter/variant: the resolved setup and whose it is. */
export interface EncounterSetupView {
  readonly kind: string;
  readonly mode: SetupMode;
  readonly mechanics: MechanicsConfig;
  readonly modifiers: EncounterModifierSelection;
  /**
   * The modifiers are the player's own saved selection, which only Reset drops, even where it
   * equals today's default; otherwise they are the default for the setup, and follow it.
   */
  readonly modifiersSaved: boolean;
  readonly startingHp: number | undefined;
  /** Mechanics (account unlocks aside) and starting hitpoints equal the defaults, with no saved modifiers. */
  readonly isDefault: boolean;
}

interface EnterEncounterOptions {
  /**
   * The run's modifier selection (the Modifiers picker's restart). Saved as the encounter's choice
   * when one is already saved or the selection differs from the automatic set; an unchanged
   * automatic set saves nothing, so it keeps following the setup.
   */
  readonly modifiers?: EncounterModifierSelection;
  /** Mechanics to save over the saved ones and start with (an Inferno setup link's). */
  readonly mechanics?: Readonly<Partial<MechanicsConfig>>;
  /** Enter in this tutorial setup instead of the saved one. */
  readonly tutorial?: TutorialSetup;
}

interface UseEncounterManagerParams {
  attackStylePerCategory: Record<string, number>;
  bindingsRef: MutableRefObject<EncounterManagerBindings | null>;
  cacheManagerRef: MutableRefObject<CacheManager>;
  getEncounterEquipment: (encounterKind: string) => PlayerEquipment;
  getEncounterInventory: (encounterKind: string) => Inventory;
  getEncounterSupplies: (encounterKind: string) => CombatSupplies;
  isFullyLoaded: boolean;
  /**
   * Dev UI harness: skip the two cache round-trips an encounter normally makes
   * (map locs, arena collision) and the landing intro, which needs a scene to
   * animate. Everything else about entering an encounter stays real.
   */
  devHarness?: boolean;
  mechanicsConfigPerEncounter: Record<string, Partial<MechanicsConfig>>;
  modifiersPerEncounter: Record<string, EncounterModifierSelection>;
  startingHpPerEncounter: Record<string, number>;
  objTypeLoader: ObjTypeLoader | null;
  playerStats: PlayerStats;
  setEncounterEquipment: (encounterKind: string, equipment: PlayerEquipment) => void;
  setEncounterInventory: (encounterKind: string, inventory: Inventory) => void;
  setEncounterSupplies: (encounterKind: string, supplies: CombatSupplies) => void;
  updateMechanicsConfigPerEncounter: (next: Record<string, Partial<MechanicsConfig>>) => void;
  updateModifiersPerEncounter: (next: Record<string, EncounterModifierSelection>) => void;
  updateStartingHpPerEncounter: (next: Record<string, number>) => void;
}

export interface UseEncounterManagerReturn {
  activeEncounterKind: string;
  /** The active scene's mechanics: its tutorial setup's in Tutorial Mode, else the saved ones. */
  activeMechanicsConfig: MechanicsConfig;
  /** The active scene's setup (Practice's): saved, or its tutorial setup. */
  activeSetup: EncounterSetupView;
  /** Variant kind mechanics config is stored under (e.g. 'yama_p3_forfeit_breath'). */
  mechanicsVariantKind: string;
  encounterDescriptor:
    | ReturnType<typeof encounterRegistry.getDescriptor>
    | ReturnType<typeof encounterRegistry.getDescriptorForKind>
    | null;
  enterEncounter: (
    kind: string,
    /** Gear for this entry only, never saved (the dev harness's preset). */
    loadoutOverride?: { equipment: PlayerEquipment; inventory: Inventory; supplies?: CombatSupplies },
    options?: EnterEncounterOptions,
  ) => void;
  enterLobby: (opts?: { playIntro?: boolean }) => void;
  exitFadePhase: 'idle' | 'fadingToBlack' | 'black';
  /** The SAVED mechanics for `encounterKind`, whatever the active scene is playing. */
  getEncounterMergedMechanicsConfig: (encounterKind: string) => MechanicsConfig;
  /** The saved setup of `encounterKind`, as the configurer shows it. */
  getSavedSetup: (encounterKind: string) => EncounterSetupView;
  /**
   * Opens the configurer on the saved setup, with `mechanics` (an Inferno setup link's) and a
   * retired kind's own run setup (the Zuk statue's wave 69) saved over it first: only their keys.
   */
  handleConfigureEncounter: (
    kind: string,
    displayName: string,
    description: string,
    mechanics?: Partial<MechanicsConfig>,
  ) => void;
  handleExitFadeTransitionEnd: () => void;
  /** Practice's mechanics edits: to the tutorial setup in Tutorial Mode, else saved. */
  handleMechanicsConfigChange: (config: MechanicsConfig) => void;
  handleReturnToLobby: () => void;
  mapLocs: LocWithType[] | null;
  persistEncounterMechanicsConfig: (encounterKind: string, config: MechanicsConfig) => void;
  resetEncounterMechanicsConfig: (encounterKind: string) => void;
  /**
   * Save `selection` (`{}`: every modifier off) as `encounterKind`'s modifiers: the player's own,
   * kept as made whatever the setup does next, even where it equals the default.
   */
  saveEncounterModifiers: (encounterKind: string, selection: EncounterModifierSelection) => void;
  /** Drop `encounterKind`'s saved modifiers, so its runs take the setup's default again. */
  resetEncounterModifiers: (encounterKind: string) => void;
  /**
   * A new engine for restarting the active scene's run, where the restart's setup builds a
   * different encounter than `current` was built with (the modifiers a changed Colosseum start
   * wave resolves to); null where resetting `current` starts the same setup. `runMechanics` are a
   * practice restart's run-only mechanics. The engine keeps `current`'s intro setting and
   * completion ownership; its loadout and recording are the restart's to set.
   */
  createRestartEngine: (
    current: SimulationEngine,
    runMechanics?: Readonly<Partial<MechanicsConfig>>,
  ) => SimulationEngine | null;
  saveEncounterStartingHp: (encounterKind: string, hitpoints: number) => void;
  /**
   * Reset `encounterKind`'s saved mechanics, modifiers and starting hitpoints to the defaults
   * (account unlocks, gear and sibling variants untouched). Returns the undo, which puts those three
   * entries back as they were, over whatever else has been saved since.
   */
  resetSavedSetup: (encounterKind: string) => () => void;
  persistEquipmentEncounterKind: string | null;
  /** The active scene's loadout for `kind`: its tutorial setup's gear, else the saved loadout. */
  getActiveSetupLoadout: (kind: string) => EncounterLoadout;
  /** Supplies the running fight chose to keep (autocast): the tutorial setup's gear, else saved. */
  setActiveSetupSupplies: (kind: string, supplies: CombatSupplies) => void;
  /** Start Tutorial Mode's setup for `kind` afresh (keeping a lesson's gear on the same kind). */
  beginTutorialSetup: (kind: string, loadout?: EncounterLoadout) => MechanicsConfig;
  /** Lay a lesson's mechanics or gear over the tutorial setup (starting one if needed). */
  updateTutorialSetup: (
    kind: string,
    update: { readonly mechanics?: Partial<MechanicsConfig>; readonly loadout?: EncounterLoadout },
  ) => MechanicsConfig;
  /** Leave the tutorial setup: the scene returns to the saved setup. Returns the dropped one. */
  endTutorialSetup: () => TutorialSetup | null;
  /**
   * Monotonic scene-instance token. Increments for every committed encounter
   * load, including same-kind reloads.
   */
  sceneLoadId: number;
  sceneState: SceneState;
  selectedLobbyEncounter: LobbyEncounterCard | null;
  setSceneState: Dispatch<SetStateAction<SceneState>>;
  setSelectedLobbyEncounter: Dispatch<SetStateAction<LobbyEncounterCard | null>>;
}

function selectionsEqual(left: EncounterModifierSelection, right: EncounterModifierSelection): boolean {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => left[key] === right[key]);
}

/**
 * The encounter constructor options a run with `modifiers` is built with, which its recording keeps
 * as `bootstrap.encounterConfig`: none for an empty set.
 */
function runOptions(modifiers: EncounterModifierSelection): { options?: { modifiers: EncounterModifierSelection } } {
  return Object.keys(modifiers).length > 0 ? { options: { modifiers } } : {};
}

/** Whether an engine built with `options` was built with exactly {@link runOptions}(`modifiers`). */
function builtWithModifiers(
  options: Readonly<Record<string, unknown>> | undefined,
  modifiers: EncounterModifierSelection,
): boolean {
  const expected = runOptions(modifiers).options;
  if (options === undefined || expected === undefined) return options === expected;
  const keys = Object.keys(options);
  return (
    keys.length === 1 &&
    keys[0] === 'modifiers' &&
    selectionsEqual(options.modifiers as EncounterModifierSelection, expected.modifiers)
  );
}

function presetsKeyFor(kind: string): string {
  return resolveEncounterPresetsKey(kind, encounterRegistry.getDescriptorForKind(kind)?.variants);
}

function cloneLoadout(loadout: EncounterLoadout): EncounterLoadout {
  return {
    equipment: cloneEquipment(loadout.equipment),
    inventory: cloneInventory(loadout.inventory),
    supplies: cloneCombatSupplies(loadout.supplies),
  };
}

/** `record` with `key` set to `value`, or without it when `value` is undefined. */
function withEntry<T>(record: Record<string, T>, key: string, value: T | undefined): Record<string, T> {
  const next = { ...record };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

export function useEncounterManager({
  attackStylePerCategory,
  bindingsRef,
  cacheManagerRef,
  getEncounterEquipment,
  getEncounterInventory,
  getEncounterSupplies,
  isFullyLoaded,
  mechanicsConfigPerEncounter,
  modifiersPerEncounter,
  startingHpPerEncounter,
  objTypeLoader,
  playerStats,
  setEncounterEquipment,
  setEncounterInventory,
  setEncounterSupplies,
  updateMechanicsConfigPerEncounter,
  updateModifiersPerEncounter,
  updateStartingHpPerEncounter,
  devHarness,
}: UseEncounterManagerParams): UseEncounterManagerReturn {
  // Guard repeated here (not taken on trust from the caller) so the bundler can
  // fold this module's harness branches.
  const harnessMode = import.meta.env.DEV && devHarness === true;
  const [sceneState, setSceneState] = useState<SceneState>({ kind: 'lobby' });
  const [sceneLoadId, setSceneLoadId] = useState(0);
  const [selectedLobbyEncounter, setSelectedLobbyEncounter] = useState<LobbyEncounterCard | null>(null);
  // The scene's tutorial setup, if it is in one. Read through its ref by the operations, so several
  // in one handler (a tutorial's entry, then its mechanics) compose before React renders.
  const [tutorial, setTutorialState] = useState<TutorialSetup | null>(null);
  const tutorialRef = useRef<TutorialSetup | null>(null);
  const setTutorial = useCallback((setup: TutorialSetup | null) => {
    tutorialRef.current = setup;
    setTutorialState(setup);
  }, []);
  const tutorialFor = useCallback((kind: string): TutorialSetup | null => {
    const setup = tutorialRef.current;
    return setup?.kind === kind ? setup : null;
  }, []);
  // The latest saved maps, for an undo that runs after other edits have been saved.
  const savedMapsRef = useRef({ mechanicsConfigPerEncounter, modifiersPerEncounter, startingHpPerEncounter });
  savedMapsRef.current = { mechanicsConfigPerEncounter, modifiersPerEncounter, startingHpPerEncounter };
  // Owner-keyed like the viewport's loaded flags: LOCs loaded for one map square are
  // only exposed while that square is still the one requested, so the render that brings
  // a new encounter already reads "no LOCs yet" instead of the previous map's.
  const [loadedMapLocs, setLoadedMapLocs] = useState<{
    key: string;
    locs: LocWithType[];
    /** An empty stand-in after a failed load: good for this visit only, never cached. */
    failed: boolean;
  } | null>(null);
  const [exitFadePhase, setExitFadePhase] = useState<'idle' | 'fadingToBlack' | 'black'>('idle');
  const exitFadeGuardRef = useRef(false);

  const activeEncounterKind =
    sceneState.kind === 'encounter'
      ? sceneState.encounterKind
      : sceneState.kind === 'loading'
        ? sceneState.targetEncounter
        : 'lobby';

  // Mechanics are stored per VARIANT kind ('yama_p3_forfeit_breath'), not per parent
  // ('yama_p3'): a variant declares its own toggles and defaults, so one contract's
  // overrides never speak for its siblings. Nothing layers a parent entry underneath,
  // which is what keeps a toggle returned to its default from clearing the variant's
  // entry and then falling straight through to a stale override on the parent.
  const mechanicsVariantKind = activeEncounterKind;

  const persistEquipmentEncounterKind = sceneState.kind === 'loading' ? null : activeEncounterKind;

  const getEncounterDefaultMechanicsConfig = useCallback(
    (encounterKind: string): Partial<MechanicsConfig> =>
      encounterControlsForKind(encounterKind)?.defaultMechanicsConfig ?? {},
    [],
  );

  /**
   * The mechanics overrides a run starts with over the encounter's defaults: the variant's saved
   * overrides with the account-wide player toggles on top, or in a tutorial setup the account
   * toggles, the lesson's own mechanics and its forced Infinite Health.
   */
  const getSetupMechanicsOverrides = useCallback(
    (encounterKind: string, setup: TutorialSetup | null): Partial<MechanicsConfig> => {
      const player = mechanicsConfigPerEncounter[PLAYER_MECHANICS_KEY];
      if (!setup) return { ...mechanicsConfigPerEncounter[encounterKind], ...player };
      return { ...player, ...setup.mechanics, infiniteHealth: true };
    },
    [mechanicsConfigPerEncounter],
  );

  const getSetupMechanics = useCallback(
    (encounterKind: string, setup: TutorialSetup | null): MechanicsConfig =>
      mergeMechanicsConfig(
        getEncounterDefaultMechanicsConfig(encounterKind),
        getSetupMechanicsOverrides(encounterKind, setup),
      ),
    [getEncounterDefaultMechanicsConfig, getSetupMechanicsOverrides],
  );

  const getEncounterMergedMechanicsConfig = useCallback(
    (encounterKind: string): MechanicsConfig => getSetupMechanics(encounterKind, null),
    [getSetupMechanics],
  );

  /**
   * The saved modifiers, else the descriptor's default for `mechanics` (a tutorial always plays the
   * default). The saved entry's presence is the whole rule: any saved selection is the player's.
   */
  const resolveSetupModifiers = useCallback(
    (
      encounterKind: string,
      setup: TutorialSetup | null,
      mechanics: Readonly<Partial<MechanicsConfig>>,
    ): EncounterModifierSelection => {
      const descriptor = encounterRegistry.getDescriptorForKind(encounterKind);
      const saved = setup ? undefined : modifiersPerEncounter[encounterKind];
      return filterModifierSelection(descriptor?.modifiers, saved ?? descriptor?.defaultModifiers?.(mechanics));
    },
    [modifiersPerEncounter],
  );

  const getSetupModifiers = useCallback(
    (encounterKind: string, setup: TutorialSetup | null): EncounterModifierSelection =>
      resolveSetupModifiers(encounterKind, setup, getSetupMechanics(encounterKind, setup)),
    [resolveSetupModifiers, getSetupMechanics],
  );

  const getSetupStartingHp = useCallback(
    (encounterKind: string, setup: TutorialSetup | null): number | undefined => {
      const variant = encounterRegistry
        .getDescriptorForKind(encounterKind)
        ?.variants?.find((entry) => entry.encounterKind === encounterKind);
      return resolveStartingHitpoints(variant, setup ? {} : startingHpPerEncounter);
    },
    [startingHpPerEncounter],
  );

  const getSetupLoadout = useCallback(
    (encounterKind: string, setup: TutorialSetup | null): EncounterLoadout => {
      if (setup?.loadout) return cloneLoadout(setup.loadout);
      const presetsKey = presetsKeyFor(encounterKind);
      return {
        equipment: getEncounterEquipment(presetsKey),
        inventory: getEncounterInventory(presetsKey),
        supplies: getEncounterSupplies(presetsKey),
      };
    },
    [getEncounterEquipment, getEncounterInventory, getEncounterSupplies],
  );

  const getSetupView = useCallback(
    (encounterKind: string, setup: TutorialSetup | null): EncounterSetupView => {
      const mechanics = getSetupMechanics(encounterKind, setup);
      const defaults = mergeMechanicsConfig(getEncounterDefaultMechanicsConfig(encounterKind));
      const modifiers = getSetupModifiers(encounterKind, setup);
      const startingHp = getSetupStartingHp(encounterKind, setup);
      const descriptor = encounterRegistry.getDescriptorForKind(encounterKind);
      const variant = descriptor?.variants?.find((entry) => entry.encounterKind === encounterKind);
      const mechanicsAreDefault = [...new Set([...Object.keys(mechanics), ...Object.keys(defaults)])].every(
        (key) => PLAYER_MECHANICS_TOGGLE_KEYS.has(key) || mechanics[key] === defaults[key],
      );
      // An encounter that offers no modifiers has no selection to save, whatever an old entry holds.
      const modifiersSaved =
        !setup && (descriptor?.modifiers?.length ?? 0) > 0 && modifiersPerEncounter[encounterKind] !== undefined;
      return {
        kind: encounterKind,
        mode: setup ? 'tutorial' : 'saved',
        mechanics,
        modifiers,
        modifiersSaved,
        startingHp,
        isDefault: mechanicsAreDefault && !modifiersSaved && startingHp === variant?.startingHitpoints,
      };
    },
    [
      getEncounterDefaultMechanicsConfig,
      getSetupMechanics,
      getSetupModifiers,
      getSetupStartingHp,
      modifiersPerEncounter,
    ],
  );

  const getSavedSetup = useCallback((encounterKind: string) => getSetupView(encounterKind, null), [getSetupView]);

  const activeTutorial = tutorial?.kind === activeEncounterKind ? tutorial : null;
  const activeSetup = useMemo(
    () => getSetupView(activeEncounterKind, activeTutorial),
    [activeEncounterKind, activeTutorial, getSetupView],
  );
  // Its own memo, so a modifier or hitpoints edit does not hand the engine sync a new config.
  const activeMechanicsConfig = useMemo(
    () => getSetupMechanics(activeEncounterKind, activeTutorial),
    [activeEncounterKind, activeTutorial, getSetupMechanics],
  );
  const encounterDescriptor =
    encounterRegistry.getDescriptor(activeEncounterKind) ?? encounterRegistry.getDescriptorForKind(activeEncounterKind);
  const encounterLoadsMapLocs = encounterDescriptor?.loadsMapLocs;
  const encounterMapSquare = encounterDescriptor?.mapSquare;
  const encounterMapSquareOffsets = encounterDescriptor?.mapSquareOffsets;

  const mapLocsKey =
    harnessMode || !isFullyLoaded || !encounterLoadsMapLocs || !encounterMapSquare
      ? null
      : `${encounterMapSquare.x},${encounterMapSquare.y}:${JSON.stringify(encounterMapSquareOffsets ?? null)}`;
  const mapLocs = mapLocsKey !== null && loadedMapLocs?.key === mapLocsKey ? loadedMapLocs.locs : null;

  useEffect(() => {
    if (mapLocsKey === null || !encounterMapSquare) return;

    const { x, y } = encounterMapSquare;
    let cancelled = false;

    cacheManagerRef.current
      .loadMapLocs(x, y, encounterMapSquareOffsets)
      .then((locs) => {
        if (!cancelled) {
          setLoadedMapLocs({ key: mapLocsKey, locs: locs ?? [], failed: false });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          log.error('useEncounterManager', 'Failed to load encounter locs', error);
          setLoadedMapLocs({ key: mapLocsKey, locs: [], failed: true });
        }
      });

    return () => {
      cancelled = true;
      // Leaving the square drops a failed stand-in, so a later visit waits for a fresh load.
      setLoadedMapLocs((stored) => (stored?.key === mapLocsKey && stored.failed ? null : stored));
    };
  }, [cacheManagerRef, mapLocsKey, encounterMapSquare, encounterMapSquareOffsets]);

  // 'auto' encounters bake real map-square loc collision (walls/pillars) plus any
  // declared dynamic locs while 'custom' encounters (e.g. Lobby) keep their own
  // getArenaConfig(). Stored globally + re-applied so new engines / re-entry pick
  // it up via SimulationEngine.applyEncounterArenaConfig.
  useEffect(() => {
    if (harnessMode || !isFullyLoaded || !encounterDescriptor) return;
    const descriptor = encounterDescriptor;
    if ((descriptor.collision?.mode ?? 'auto') === 'custom') return;

    let cancelled = false;
    const seed = descriptor.collision?.seed ?? descriptor.playerStart;
    const extraLocs = descriptor.collision?.dynamicLocs?.map(toCollisionLocInput);

    cacheManagerRef.current
      .buildArenaConfig({
        mapX: descriptor.mapSquare.x,
        mapY: descriptor.mapSquare.y,
        seedX: seed[0],
        seedY: seed[1],
        mapSquareOffsets: descriptor.mapSquareOffsets,
        extraLocs,
        excludedStaticLocIds: descriptor.collision?.excludedStaticLocIds,
      })
      .then((config) => {
        if (cancelled) return;
        // Build miss (no cache map): keep the encounter's pre-cache placeholder.
        if (config.bounds === null && config.walkableTiles === null && config.collisionMap === null) {
          return;
        }
        setResolvedArenaConfig(descriptor.kind, config);
        bindingsRef.current?.engineRef.current.reapplyArenaConfig();
      })
      .catch((error) => {
        if (!cancelled) log.error('useEncounterManager', 'Failed to resolve arena collision', error);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheManagerRef, bindingsRef, encounterDescriptor, harnessMode, isFullyLoaded]);

  const buildEngineForScene = useCallback(
    (
      nextScene: SceneState,
      opts: {
        enableIntro?: boolean;
        /** The tutorial setup the run starts in; null for the saved setup. */
        tutorial: TutorialSetup | null;
        /** Saved this same handler, so not yet in this render's state. */
        modifiers?: EncounterModifierSelection;
        mechanics?: Readonly<Partial<MechanicsConfig>>;
      },
    ) => {
      const encounterKind =
        nextScene.kind === 'encounter'
          ? nextScene.encounterKind
          : nextScene.kind === 'loading'
            ? nextScene.targetEncounter
            : 'lobby';

      const descriptor = encounterRegistry.getDescriptorForKind(encounterKind);
      const startHp = getSetupStartingHp(encounterKind, opts.tutorial);
      const mechanics = { ...getSetupMechanicsOverrides(encounterKind, opts.tutorial), ...opts.mechanics };
      // The default follows the mechanics this run starts with, an entry's own included.
      const modifiers =
        opts.modifiers !== undefined
          ? filterModifierSelection(descriptor?.modifiers, opts.modifiers)
          : resolveSetupModifiers(
              encounterKind,
              opts.tutorial,
              mergeMechanicsConfig(getEncounterDefaultMechanicsConfig(encounterKind), mechanics),
            );
      const bindings = bindingsRef.current;
      return createSimulationEngineForNewRun({
        encounterConfig: {
          kind: encounterKind,
          mechanics,
          ...runOptions(modifiers),
        },
        objTypeLoader,
        // The landing intro is a scene animation; without a viewport nothing
        // would ever complete it and the fight would never start.
        enableIntro: harnessMode ? false : (opts.enableIntro ?? encounterEnablesIntro(encounterKind)),
        stats: playerStats,
        ...(startHp === undefined ? {} : { startHp }),
        inventory: bindings?.playerInventoryRef.current ?? createEmptyInventory(),
        equipment: bindings?.playerEquipmentRef.current ?? {},
        combatSupplies: bindings?.playerCombatSuppliesRef.current ?? createEmptyCombatSupplies(),
        attackStylePerCategory,
      });
    },
    [
      attackStylePerCategory,
      bindingsRef,
      getEncounterDefaultMechanicsConfig,
      getSetupMechanicsOverrides,
      resolveSetupModifiers,
      getSetupStartingHp,
      objTypeLoader,
      playerStats,
      harnessMode,
    ],
  );

  const enterLobby = useCallback(
    (opts?: { playIntro?: boolean }) => {
      const bindings = bindingsRef.current;
      if (!bindings) return;

      setTutorial(null);
      const emptyEquipment: PlayerEquipment = {};
      const emptyInventory = createEmptyInventory();
      const emptySupplies = createEmptyCombatSupplies();
      bindings.setPlayerConfig((prev) => ({ ...prev, equipment: emptyEquipment }));
      bindings.playerEquipmentRef.current = emptyEquipment;
      bindings.playerInventoryRef.current = emptyInventory;
      bindings.playerCombatSuppliesRef.current = emptySupplies;
      setEncounterEquipment('lobby', emptyEquipment);
      setEncounterInventory('lobby', emptyInventory);
      setEncounterSupplies('lobby', emptySupplies);

      const nextScene: SceneState = { kind: 'lobby' };
      const nextEngine = buildEngineForScene(nextScene, { enableIntro: opts?.playIntro ?? false, tutorial: null });
      setSceneState(nextScene);
      bindings.setEngine(nextEngine);
      bindings.setSimulationState(nextEngine.getState());
      bindings.setIsSceneReady(false);
      bindings.setTargetTile(null);
      bindings.targetTileRef.current = null;
      bindings.replay.resetReplay();
    },
    [bindingsRef, buildEngineForScene, setEncounterEquipment, setEncounterInventory, setEncounterSupplies, setTutorial],
  );

  const enterLobbyRef = useRef(enterLobby);
  enterLobbyRef.current = enterLobby;

  const handleReturnToLobby = useCallback(() => {
    if (exitFadeGuardRef.current) return;
    exitFadeGuardRef.current = true;
    setExitFadePhase('fadingToBlack');
  }, []);

  const handleExitFadeTransitionEnd = useCallback(() => {
    if (exitFadePhase !== 'fadingToBlack') return;
    setExitFadePhase('black');
    enterLobbyRef.current({ playIntro: true });
  }, [exitFadePhase]);

  useEffect(() => {
    if (exitFadePhase !== 'black') return;
    if (!bindingsRef.current?.simulationStateRef.current.introActive) return;
    setExitFadePhase('idle');
    exitFadeGuardRef.current = false;
  }, [bindingsRef, exitFadePhase]);

  useEffect(() => {
    if (exitFadePhase !== 'black') return;
    const fallback = setTimeout(() => {
      setExitFadePhase('idle');
      exitFadeGuardRef.current = false;
    }, 3000);
    return () => clearTimeout(fallback);
  }, [exitFadePhase]);

  /** Save `mechanics` (only their own keys) over `kind`'s saved mechanics. */
  const mergeSavedMechanics = useCallback(
    (kind: string, mechanics: Readonly<Partial<MechanicsConfig>>) => {
      if (Object.keys(mechanics).length === 0) return;
      updateMechanicsConfigPerEncounter({
        ...mechanicsConfigPerEncounter,
        [kind]: { ...mechanicsConfigPerEncounter[kind], ...mechanics },
      });
    },
    [mechanicsConfigPerEncounter, updateMechanicsConfigPerEncounter],
  );

  const persistEncounterMechanicsConfig = useCallback(
    (encounterKind: string, config: MechanicsConfig) => {
      const encounterDefaults = getEncounterDefaultMechanicsConfig(encounterKind);
      const nextOverrides: Partial<MechanicsConfig> = {};
      const nextPlayerOverrides: Partial<MechanicsConfig> = {
        ...mechanicsConfigPerEncounter[PLAYER_MECHANICS_KEY],
      };

      for (const [key, value] of Object.entries(config)) {
        if (value === undefined) continue;
        // An account unlock is stored once for every encounter, so it is compared against the
        // GLOBAL default rather than this encounter's, which never speaks for it.
        if (PLAYER_MECHANICS_TOGGLE_KEYS.has(key)) {
          if (DEFAULT_MECHANICS_CONFIG[key] === value) delete nextPlayerOverrides[key];
          else nextPlayerOverrides[key] = value;
          continue;
        }
        if (encounterDefaults[key] !== value) {
          nextOverrides[key] = value;
        }
      }

      const nextPerEncounter = { ...mechanicsConfigPerEncounter };
      if (Object.keys(nextOverrides).length > 0) {
        nextPerEncounter[encounterKind] = nextOverrides;
      } else {
        delete nextPerEncounter[encounterKind];
      }
      if (Object.keys(nextPlayerOverrides).length > 0) {
        nextPerEncounter[PLAYER_MECHANICS_KEY] = nextPlayerOverrides;
      } else {
        delete nextPerEncounter[PLAYER_MECHANICS_KEY];
      }

      updateMechanicsConfigPerEncounter(nextPerEncounter);
    },
    [getEncounterDefaultMechanicsConfig, mechanicsConfigPerEncounter, updateMechanicsConfigPerEncounter],
  );

  const resetEncounterMechanicsConfig = useCallback(
    (encounterKind: string) => {
      if (!(encounterKind in mechanicsConfigPerEncounter)) return;
      const nextPerEncounter = { ...mechanicsConfigPerEncounter };
      delete nextPerEncounter[encounterKind];
      updateMechanicsConfigPerEncounter(nextPerEncounter);
    },
    [mechanicsConfigPerEncounter, updateMechanicsConfigPerEncounter],
  );

  const saveEncounterModifiers = useCallback(
    (encounterKind: string, selection: EncounterModifierSelection) => {
      updateModifiersPerEncounter({ ...modifiersPerEncounter, [encounterKind]: { ...selection } });
    },
    [modifiersPerEncounter, updateModifiersPerEncounter],
  );

  const resetEncounterModifiers = useCallback(
    (encounterKind: string) => {
      if (!(encounterKind in modifiersPerEncounter)) return;
      updateModifiersPerEncounter(withEntry(modifiersPerEncounter, encounterKind, undefined));
    },
    [modifiersPerEncounter, updateModifiersPerEncounter],
  );

  const saveEncounterStartingHp = useCallback(
    (encounterKind: string, hitpoints: number) => {
      updateStartingHpPerEncounter({ ...startingHpPerEncounter, [encounterKind]: hitpoints });
    },
    [startingHpPerEncounter, updateStartingHpPerEncounter],
  );

  const resetSavedSetup = useCallback(
    (encounterKind: string): (() => void) => {
      const before = {
        mechanics: mechanicsConfigPerEncounter[encounterKind],
        modifiers: modifiersPerEncounter[encounterKind],
        startingHp: startingHpPerEncounter[encounterKind],
      };
      resetEncounterMechanicsConfig(encounterKind);
      if (encounterKind in modifiersPerEncounter) {
        updateModifiersPerEncounter(withEntry(modifiersPerEncounter, encounterKind, undefined));
      }
      if (encounterKind in startingHpPerEncounter) {
        updateStartingHpPerEncounter(withEntry(startingHpPerEncounter, encounterKind, undefined));
      }
      return () => {
        const latest = savedMapsRef.current;
        updateMechanicsConfigPerEncounter(
          withEntry(latest.mechanicsConfigPerEncounter, encounterKind, before.mechanics),
        );
        updateModifiersPerEncounter(withEntry(latest.modifiersPerEncounter, encounterKind, before.modifiers));
        updateStartingHpPerEncounter(withEntry(latest.startingHpPerEncounter, encounterKind, before.startingHp));
      };
    },
    [
      mechanicsConfigPerEncounter,
      modifiersPerEncounter,
      resetEncounterMechanicsConfig,
      startingHpPerEncounter,
      updateMechanicsConfigPerEncounter,
      updateModifiersPerEncounter,
      updateStartingHpPerEncounter,
    ],
  );

  const enterEncounter = useCallback(
    (
      requestedKind: string,
      loadoutOverride?: { equipment: PlayerEquipment; inventory: Inventory; supplies?: CombatSupplies },
      options?: EnterEncounterOptions,
    ) => {
      const bindings = bindingsRef.current;
      if (!bindings) return;
      // A retired kind (`zuk`: the lobby NPC, a `/zuk` link or a saved scene) enters the encounter that
      // owns it, at the run setup it stands for, saved over the rest as a pick in the setup would be.
      const entryPoint = resolveEncounterEntry(requestedKind);
      if (!entryPoint || !encounterRegistry.hasKind(entryPoint.kind)) {
        log.warn('useEncounterManager', `Ignoring unsupported encounter transition request: '${requestedKind}'`);
        return;
      }
      const kind = entryPoint.kind;
      const setup = options?.tutorial ? { ...options.tutorial, kind } : null;
      setTutorial(setup);
      // A tutorial saves nothing; its run setup is its own.
      const entryMechanics = setup ? {} : { ...entryPoint.mechanics, ...options?.mechanics };
      mergeSavedMechanics(kind, entryMechanics);
      if (options?.modifiers !== undefined && !setup) {
        // The picker submits the set it showed, edited or not. Only an edit becomes a saved set: an
        // unchanged automatic one stays automatic, so it goes on following the setup. A saved set
        // takes whatever is submitted, as any edit of it would.
        const descriptor = encounterRegistry.getDescriptorForKind(kind);
        const automatic = resolveSetupModifiers(
          kind,
          null,
          mergeMechanicsConfig(getEncounterDefaultMechanicsConfig(kind), {
            ...getSetupMechanicsOverrides(kind, null),
            ...entryMechanics,
          }),
        );
        const unchanged = selectionsEqual(filterModifierSelection(descriptor?.modifiers, options.modifiers), automatic);
        if (kind in modifiersPerEncounter || !unchanged) saveEncounterModifiers(kind, options.modifiers);
      }

      const loadout = getSetupLoadout(kind, setup);
      const encounterEquipment = loadoutOverride?.equipment ?? loadout.equipment;
      const encounterInventory = loadoutOverride?.inventory ?? loadout.inventory;
      const encounterSupplies = loadoutOverride?.supplies ?? loadout.supplies;

      bindings.setPlayerConfig((prev) => ({ ...prev, equipment: encounterEquipment }));
      bindings.playerEquipmentRef.current = encounterEquipment;
      bindings.playerInventoryRef.current = cloneInventory(encounterInventory);
      bindings.playerCombatSuppliesRef.current = encounterSupplies;

      const loadingScene: SceneState = { kind: 'loading', targetEncounter: kind };
      const nextEngine = buildEngineForScene(
        { kind: 'encounter', encounterKind: kind },
        { tutorial: setup, modifiers: options?.modifiers, mechanics: entryMechanics },
      );
      nextEngine.setEquipment(encounterEquipment);
      nextEngine.setInventory(bindings.playerInventoryRef.current);
      nextEngine.setCombatSupplies(encounterSupplies);

      bindings.setEngine(nextEngine);
      bindings.setSimulationState(nextEngine.getState());
      setSceneState(loadingScene);
      setSceneLoadId((id) => id + 1);
      bindings.setIsSceneReady(false);
      bindings.setTargetTile(null);
      bindings.targetTileRef.current = null;
      bindings.replay.resetReplay();
    },
    [
      bindingsRef,
      buildEngineForScene,
      getEncounterDefaultMechanicsConfig,
      getSetupLoadout,
      getSetupMechanicsOverrides,
      mergeSavedMechanics,
      modifiersPerEncounter,
      resolveSetupModifiers,
      saveEncounterModifiers,
      setTutorial,
    ],
  );

  const createRestartEngine = useCallback(
    (current: SimulationEngine, runMechanics: Readonly<Partial<MechanicsConfig>> = {}): SimulationEngine | null => {
      if (sceneState.kind !== 'encounter') return null;
      const scene = sceneState;
      const kind = scene.encounterKind;
      const setup = tutorialFor(kind);
      // The same setup a fresh entry resolves, at the mechanics the restarted run starts with.
      const modifiers = resolveSetupModifiers(kind, setup, { ...getSetupMechanics(kind, setup), ...runMechanics });
      const { bootstrap, completionOwnership } = current.getRunConfig();
      if (builtWithModifiers(bootstrap?.encounterConfig, modifiers)) return null;
      const engine = buildEngineForScene(scene, {
        tutorial: setup,
        modifiers,
        ...(bootstrap ? { enableIntro: bootstrap.enableIntro } : {}),
      });
      engine.setCompletionOwnership(completionOwnership);
      return engine;
    },
    [buildEngineForScene, getSetupMechanics, resolveSetupModifiers, sceneState, tutorialFor],
  );

  const handleMechanicsConfigChange = useCallback(
    (config: MechanicsConfig) => {
      const setup = tutorialFor(mechanicsVariantKind);
      if (!setup) {
        persistEncounterMechanicsConfig(mechanicsVariantKind, config);
        return;
      }
      // Only what changed joins the lesson's mechanics; nothing is saved, account unlocks included.
      const current = getSetupMechanics(mechanicsVariantKind, setup);
      const own: Partial<MechanicsConfig> = { ...setup.mechanics };
      for (const [key, value] of Object.entries(config)) {
        if (value !== undefined && value !== current[key]) own[key] = value;
      }
      setTutorial({ ...setup, mechanics: own });
    },
    [getSetupMechanics, mechanicsVariantKind, persistEncounterMechanicsConfig, setTutorial, tutorialFor],
  );

  const getActiveSetupLoadout = useCallback(
    (kind: string): EncounterLoadout => {
      const setup = tutorialRef.current;
      const own = setup?.loadout && (setup.kind === kind || presetsKeyFor(setup.kind) === kind) ? setup : null;
      return getSetupLoadout(kind, own);
    },
    [getSetupLoadout],
  );

  const setActiveSetupSupplies = useCallback(
    (kind: string, supplies: CombatSupplies) => {
      const setup = tutorialRef.current;
      if (setup?.loadout && (setup.kind === kind || presetsKeyFor(setup.kind) === kind)) {
        setTutorial({ ...setup, loadout: { ...setup.loadout, supplies: cloneCombatSupplies(supplies) } });
        return;
      }
      setEncounterSupplies(presetsKeyFor(kind), supplies);
    },
    [setEncounterSupplies, setTutorial],
  );

  const beginTutorialSetup = useCallback(
    (kind: string, loadout?: EncounterLoadout): MechanicsConfig => {
      const setup = tutorialSetup(kind, loadout ?? tutorialFor(kind)?.loadout);
      setTutorial(setup);
      return getSetupMechanics(kind, setup);
    },
    [getSetupMechanics, setTutorial, tutorialFor],
  );

  const updateTutorialSetup = useCallback(
    (
      kind: string,
      update: { readonly mechanics?: Partial<MechanicsConfig>; readonly loadout?: EncounterLoadout },
    ): MechanicsConfig => {
      const current = tutorialFor(kind) ?? tutorialSetup(kind);
      const setup: TutorialSetup = {
        ...current,
        mechanics: { ...current.mechanics, ...update.mechanics },
        ...(update.loadout ? { loadout: update.loadout } : {}),
      };
      setTutorial(setup);
      return getSetupMechanics(kind, setup);
    },
    [getSetupMechanics, setTutorial, tutorialFor],
  );

  const endTutorialSetup = useCallback((): TutorialSetup | null => {
    const setup = tutorialRef.current;
    if (setup) setTutorial(null);
    return setup;
  }, [setTutorial]);

  const handleConfigureEncounter = useCallback(
    (requestedKind: string, displayName: string, description: string, mechanics?: Partial<MechanicsConfig>) => {
      // A retired kind (the Zuk statue's `zuk`) configures the encounter that owns it, at the run
      // setup it stands for (wave 69). That and a link's `mechanics` are saved over the saved setup,
      // key by key: neither may cost the player the rest of it.
      const entryPoint = resolveEncounterEntry(requestedKind);
      const kind = entryPoint?.kind ?? requestedKind;
      mergeSavedMechanics(kind, { ...entryPoint?.mechanics, ...mechanics });
      const card = Object.values(LOBBY_NPC_ENCOUNTERS).find((entry) => entry.encounterKind === requestedKind);
      if (card) {
        setSelectedLobbyEncounter({ ...card, encounterKind: kind });
        return;
      }
      setSelectedLobbyEncounter({ encounterKind: kind, displayName, description });
    },
    [mergeSavedMechanics],
  );

  return {
    activeEncounterKind,
    activeMechanicsConfig,
    activeSetup,
    mechanicsVariantKind,
    encounterDescriptor,
    enterEncounter,
    enterLobby,
    exitFadePhase,
    getEncounterMergedMechanicsConfig,
    getSavedSetup,
    handleConfigureEncounter,
    handleExitFadeTransitionEnd,
    handleMechanicsConfigChange,
    handleReturnToLobby,
    mapLocs,
    persistEncounterMechanicsConfig,
    resetEncounterMechanicsConfig,
    saveEncounterModifiers,
    resetEncounterModifiers,
    createRestartEngine,
    saveEncounterStartingHp,
    resetSavedSetup,
    persistEquipmentEncounterKind,
    getActiveSetupLoadout,
    setActiveSetupSupplies,
    beginTutorialSetup,
    updateTutorialSetup,
    endTutorialSetup,
    sceneLoadId,
    sceneState,
    selectedLobbyEncounter,
    setSceneState,
    setSelectedLobbyEncounter,
  };
}
