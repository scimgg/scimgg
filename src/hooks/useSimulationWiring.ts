import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AudioEngine, EventAudioPlayer, FrameSoundTracker } from '../audio';
import type { PrayerFlickInputKind } from '../components/prayerFlick';
import { prayerFlickTimeline } from '../components/prayerFlickTimeline';
import { SIMULATION_START_TICK } from '../core/constants';
import type { EncounterCommand } from '../core/encounters/commands';
import type {
  EncounterCompletionOwnership,
  EncounterPracticeRestart,
  EquipmentClickSlot,
} from '../core/encounters/types';
import type { PendingInputOp } from '../core/inputOps';
import { type PrayerInputState, type QueuedPrayerAction, resolvePrayerActions } from '../core/prayerInput';
import type { ReplayUiState, ReplayViewportState } from '../core/ReplayRecorder';
import type { ReplayOverlays, ReplayPresentationState } from '../core/replayPresentation';
import { type InventoryEquipmentPreview, SimulationEngine } from '../core/SimulationEngine';
import { resolveEquipmentItemName } from '../data/equipmentCatalog';
import type { ItemActionOption } from '../data/itemEffects';
import { formatLoadout } from '../debug/dumpLoadout';
import { LobbyEncounter } from '../encounters/lobby/LobbyEncounter';
import { encounterOffersCountdownMovement } from '../encounters/modules';
import { encounterPracticeSession } from '../encounters/practiceChrome';
import { isSyntheticInput, runSyntheticInput } from '../input/inputProvenance';
import type { FightStartCountdownPhase } from '../render/graphics/sceneObjectTypes';
import type { ObjTypeLoader } from '../rs/config/objtype/ObjTypeLoader';
import type { PlayerEquipment } from '../rs/model/PlayerModelLoader';
import { tickBus } from '../tutorial/runtime/tickBus';
import { getWeaponCategoryKey } from '../types/attackStyles';
import { type CombatSupplies, createEmptyCombatSupplies } from '../types/encounterLoadout';
import { createEmptyInventory, type Inventory } from '../types/inventory';
import type { PlayerConfig } from '../types/player';
import type { PracticeSessionState } from '../types/practiceSession';
import {
  type Coordinate,
  type MechanicsConfig,
  PRAYER_CATEGORIES,
  type PrayerCategory,
  PrayerType,
  type SimulationState,
} from '../types/simulation';
import type { StartPositionPreparation } from '../types/startPositionPreparation';
import { animationFrames } from '../util/animationFrames';
import {
  carryWornEquipment,
  cloneInventory,
  equipmentEqual,
  inventoryEqual,
  type WornLoadout,
} from '../util/loadoutUtils';
import { TickTimingMonitor } from '../util/TickTimingMonitor';
import { InputLagBuffer, inputLagWallClockDelay } from './inputLagBuffer';
import { useBackgroundSuspended } from './useBackgroundSuspended';
import { type FightStartCountdownDescriptor, useFightStartCountdown } from './useFightStartCountdown';
import { type UseReplayReturn, useReplay } from './useReplay';
import { useSentInputPreview, useSentInputPreviewRef } from './useSentInputPreview';

declare global {
  interface Window {
    /** Dev helper: print + copy the live loadout. Registered by useSimulationWiring. */
    dumpInventory?: () => string;
  }
}

export type SceneState =
  | { kind: 'lobby' }
  | { kind: 'loading'; targetEncounter: string }
  | { kind: 'encounter'; encounterKind: string };

interface UseSimulationWiringParams {
  activeMechanicsConfig: MechanicsConfig;
  attackStylePerCategory: Record<string, number>;
  autoAdvance: boolean;
  readonly pauseWhenUnfocused: boolean;
  /**
   * A modal covers the screen, or an encounter tool (Edit layout) is open over the fight. The live
   * tick loop stops as it does for a manual pause, and finishes
   * the tick it stopped in once the modal closes; replay playback holds as it does under focus
   * suspension. Neither the user's pause, a tutorial hold, the intro nor focus suspension is touched,
   * so whichever of them still applies when the modal closes keeps the fight paused.
   */
  readonly modalPaused: boolean;
  /**
   * The 3D view cannot draw (its context is lost, restoring or failed). Holds exactly as
   * {@link modalPaused} does, for the same reason: a fight or a replay the player cannot see should
   * not carry on. It also refuses replay practice, tutorial fast-forwards and, in
   * useViewportInteraction, world clicks. Released as soon as the view reports it is drawing again.
   */
  readonly graphicsHeld?: boolean;
  readonly replayPracticeUnavailableReason?: string | null;
  readonly replayPracticeHeld?: { readonly current: boolean };
  /**
   * The start-of-fight countdown's length, or null for none (the setting off, Tutorial Mode). It runs
   * when a live run starts in an encounter (entering one, Restart) and holds the live tick loop the
   * way a modal does, until it ends. Replay viewing and manual stepping never count down.
   * Encounters that opt in allow start positioning after any landing intro; restored countdowns
   * never move. See docs/architecture/movement-and-facing.md#countdown-start-positioning.
   */
  readonly fightStartCountdownTicks: number | null;
  /** The intro animation's remaining time, for the countdown to end with it; see useFightStartCountdown. */
  readonly getIntroAnimationRemainingMs?: (expectedSpeedMultiplier: number) => number | null | undefined;
  audioEngine: AudioEngine;
  eventAudioPlayerRef: MutableRefObject<EventAudioPlayer>;
  frameSoundTrackerRef: MutableRefObject<FrameSoundTracker>;
  getEncounterEquipment: (encounterKind: string) => PlayerEquipment;
  getEncounterInventory: (encounterKind: string) => Inventory;
  getEncounterSupplies: (encounterKind: string) => CombatSupplies;
  setEncounterSupplies: (encounterKind: string, supplies: CombatSupplies) => void;
  isFullyLoaded: boolean;
  instantInventoryEnabled: boolean;
  instantPrayerEnabled: boolean;
  objTypeLoader: ObjTypeLoader | null;
  persistEquipmentEncounterKind: string | null;
  playerConfig: PlayerConfig;
  getReplayUiState: () => ReplayUiState;
  getReplayViewportState?: () => ReplayViewportState | undefined;
  getPresentationState?: () => ReplayPresentationState | null;
  getOverlays?: () => ReplayOverlays | null;
  onReplayUiStateChange: (uiState: ReplayUiState) => void;
  /** `'none'` mounts no viewport at all (UI test harness) — see {@link GridProps.rendererType}. */
  rendererType: 'webgl' | 'canvas2d' | 'none';
  sceneState: SceneState;
  setPlayerConfig: Dispatch<SetStateAction<PlayerConfig>>;
  setSceneState: Dispatch<SetStateAction<SceneState>>;
  speedMultiplier: number;
  /** Simulated input latency in ms (0 = instant). Only applies in auto-advance play. */
  inputLagMs: number;
  updateAttackStylePerCategory: (next: Record<string, number>) => void;
}

/** `[hasPreview, prayer]` — mirrors `SimulationState.pendingProtectionPrayer`. */
type PrayerSlotPreview = [boolean, PrayerType | null];

/** `[hasPreview, prayers]` — mirrors `SimulationState.pendingIndependentPrayers`. */
type IndependentPrayerPreview = [boolean, readonly PrayerType[]];

/** Prayers whose local bit the client has flipped, keyed by prayer. */
export type PrayerBits = Readonly<Partial<Record<PrayerType, boolean>>>;

/**
 * Everything the prayer book and the prayer orb render, composed once here so no
 * consumer re-derives it from engine projections.
 */
export interface PrayerPresentation {
  /** Each slot's base prayer before local bits: committed state, or the Instant Prayer prediction. */
  readonly protection: PrayerType | null;
  readonly offensive: PrayerType | null;
  /** The independent prayers lit. A set, not a slot: these evict nothing and nothing evicts them. */
  readonly independent: readonly PrayerType[];
  /** Bits the client flipped that the server has not answered yet. Outranks the slot. */
  readonly visualOverrides: PrayerBits;
  /** Whether the book has anything lit at all, which is what the orb's active styling reads. */
  readonly anyLit: boolean;
}

export interface InputPresentation {
  readonly runEnabled: boolean | undefined;
  readonly specialAttackActive: boolean | undefined;
  readonly selectedAttackStyleIndex: number | undefined;
  readonly selectedSpell: string | null | undefined;
  /**
   * The walk destination to draw: a click still crossing the lag buffer, else the committed one.
   * A getter the renderer reads every frame, so a world click does not re-render the app.
   */
  readonly getTargetTile: () => Coordinate | null;
  /** The live countdown positioning walk, or null; a getter the viewports read every frame. */
  readonly getStartPositionPreparation: () => StartPositionPreparation | null;
}

const NO_PRAYER_SLOT_PREVIEW: PrayerSlotPreview = [false, null];
const NO_INDEPENDENT_PRAYERS: readonly PrayerType[] = [];
const NO_INDEPENDENT_PREVIEW: IndependentPrayerPreview = [false, NO_INDEPENDENT_PRAYERS];
const NO_PRAYER_BITS: PrayerBits = {};
const NO_SENT_STAMP = (): void => {};

/**
 * The running tick loop's schedule, on the active clock. Shared with the reset and engine-swap
 * paths, which restart it for the new recording.
 */
interface LiveTickSchedule {
  /** When the running tick is due to end. Meaningless while `frozenRemainingMs` is set. */
  boundaryMs: number;
  readonly intervalMs: number;
  readonly speedMultiplier: number;
  /** The engine this schedule times. A frame that finds another one waits for the restart. */
  engine: SimulationEngine;
  /** An unexecuted GO boundary, distinct from an ordinary due tick. Cleared on run restart. */
  countdownKey: number | null;
  /**
   * Set while the engine cannot advance (a tutorial hold, an intro, the fight over): the time
   * that was left in the tick, possibly negative if it was already due. Time spent inactive is
   * excluded from the tick, like suspended time, so it never makes the next tick late.
   */
  frozenRemainingMs: number | null;
}

/** A countdown belongs to one starting boundary, even when Restart reuses the engine object. */
interface CountdownRun {
  readonly engine: SimulationEngine;
  readonly tick: number;
  key: number | null;
  released: boolean;
}

/**
 * Countdown positioning for one fresh countdown boundary: open from a fresh start until it is
 * committed (the run then starts on the chosen tile) or dropped with the run it belonged to.
 */
interface StartPreparationSession {
  readonly run: CountdownRun;
  readonly engine: SimulationEngine;
  /** The viewports' identity for this boundary: an inert key, so it pins nothing as they keep it. */
  readonly boundary: object;
  /** The timed countdown whose interval boundaries step, and the next boundary's index from its start. */
  cadence: { readonly key: number; nextIndex: number } | null;
  sequence: number;
  /**
   * Whether the walk was ever allowed during this countdown. Every fresh tick-0 countdown opens a
   * session, but only one that offered the walk commits its start at GO: the permission is read live
   * (the setup stays editable at tick 0), and a walk it later withdraws still starts where it got to.
   */
  offered: boolean;
}

/** What decides whether live audio is held, short of whether the engine can run. */
interface LiveAudioHoldInputs {
  /** Replay playback owns the audio; the live hold lets go of it. */
  readonly replayMode: boolean;
  /** The live tick loop would run if nothing held it: auto-advance on, loaded, past the intro and countdown. */
  readonly loopEnabled: boolean;
  /** Focus suspension or a covering modal. */
  readonly held: boolean;
}

/** The loadout a fresh run starts with. */
interface RunLoadout {
  readonly equipment: PlayerEquipment;
  readonly inventory: Inventory;
  readonly supplies: CombatSupplies;
}

/** Tutorial Mode's fresh run: the loadout to keep, and the mechanics it runs under. */
export interface TutorialRunSetup extends RunLoadout {
  readonly mechanicsConfig: MechanicsConfig;
}

/** What a stopped loop leaves for the next one: the time left in its tick, for its own engine and tick only. */
interface CarriedTickSchedule {
  readonly remainingMs: number;
  readonly intervalMs: number;
  readonly engine: SimulationEngine;
  readonly tick: number;
  /** A carried zero from GO cannot survive cancellation as an ordinary overdue tick. */
  readonly countdownKey: number | null;
}

/**
 * The time left in a carried tick, at the new interval when the speed changed. A tick that was
 * already due stays exactly as overdue, so it runs on the next frame and counts as late.
 */
/** Whether the engine takes ticks now; while it does not, the live tick is frozen. */
function engineCanRun(engine: SimulationEngine): boolean {
  return engine.canAdvance() && !engine.isTutorialPaused();
}

function continuedRemainingMs(carried: CarriedTickSchedule, intervalMs: number): number {
  return carried.remainingMs > 0 ? carried.remainingMs * (intervalMs / carried.intervalMs) : carried.remainingMs;
}

interface PrayerBitWrite {
  readonly prayer: PrayerType;
  readonly lit: boolean;
}

/**
 * Which click owns each local bit, and the tick that answers it — null until the
 * click reaches the engine. One entry per prayer, so a stalled simulation cannot
 * grow this: a newer click on a prayer replaces the older one's claim outright.
 */
type PrayerBitOwners = Partial<Record<PrayerType, { readonly seq: number; readonly answeredAtTick: number | null }>>;

/** Drop every bit whose answering tick has now been published, and the owners with them. */
function retireAnsweredPrayerBits(bits: PrayerBits, owners: PrayerBitOwners, publishedTick: number) {
  let nextBits = bits;
  let nextOwners = owners;
  for (const prayer of Object.values(PrayerType)) {
    const answeredAtTick = owners[prayer]?.answeredAtTick;
    if (answeredAtTick === undefined || answeredAtTick === null || publishedTick < answeredAtTick) continue;
    const { [prayer]: _answeredBit, ...remainingBits } = nextBits;
    const { [prayer]: _answeredOwner, ...remainingOwners } = nextOwners;
    nextBits = remainingBits;
    nextOwners = remainingOwners;
  }
  return { bits: nextBits, owners: nextOwners, changed: nextBits !== bits };
}

function isSlotLit(prayer: PrayerType | null, bits: PrayerBits): boolean {
  return prayer !== null && bits[prayer] !== false;
}

function anyPrayerLit(
  protection: PrayerType | null,
  offensive: PrayerType | null,
  independent: readonly PrayerType[],
  bits: PrayerBits,
): boolean {
  return (
    isSlotLit(protection, bits) ||
    isSlotLit(offensive, bits) ||
    independent.some((prayer) => isSlotLit(prayer, bits)) ||
    Object.values(bits).some((lit) => lit === true)
  );
}

/**
 * The Instant Prayer prediction for a slot, which outranks the engine's queued
 * prayer, which in turn outranks the prayer already burning.
 */
function resolvePredictedPrayer(
  preview: PrayerSlotPreview,
  pending: readonly [boolean, PrayerType | null],
  committed: PrayerType | null,
): PrayerType | null {
  if (preview[0]) return preview[1];
  if (pending[0]) return pending[1];
  return committed;
}

/** Same precedence as {@link resolvePredictedPrayer}, for the independent SET. */
function resolvePredictedIndependent(
  preview: IndependentPrayerPreview,
  pending: readonly [boolean, readonly PrayerType[]],
  committed: readonly PrayerType[],
): readonly PrayerType[] {
  if (preview[0]) return preview[1];
  if (pending[0]) return pending[1];
  return committed;
}

/**
 * What a viewer with no input of their own sees: committed state, no prediction.
 * Replay and demo playback render recorded ticks, so nothing is ever in flight.
 */
export function committedPrayerPresentation(state: {
  activePrayer: PrayerType | null;
  offensivePrayer: PrayerType | null;
  independentPrayers?: readonly PrayerType[];
}): PrayerPresentation {
  const independent = state.independentPrayers ?? NO_INDEPENDENT_PRAYERS;
  return {
    protection: state.activePrayer,
    offensive: state.offensivePrayer,
    independent,
    visualOverrides: NO_PRAYER_BITS,
    anyLit: anyPrayerLit(state.activePrayer, state.offensivePrayer, independent, NO_PRAYER_BITS),
  };
}

export interface UseSimulationWiringReturn {
  readonly focusPaused: boolean;
  engine: SimulationEngine;
  engineRef: MutableRefObject<SimulationEngine>;
  /** Route a player input through the simulated-latency buffer (or apply it instantly when lag is off). */
  dispatchInput: (apply: () => void) => void;
  handleAttackStyleChange: (index: number) => void;
  handleSelectedSpellChange: (spellName: string) => void;
  handleEquipFromInventory: (inventoryIndex: number) => Inventory | null;
  handleEquipmentSlotClick: (slot: string) => boolean;
  handleIntroComplete: () => void;
  /** The start-of-fight countdown to show, or null; actual release follows the deadline and intro. */
  fightStartCountdown: FightStartCountdownDescriptor | null;
  /** Pending, counting or showing GO, independently of whether a timed descriptor exists. */
  fightStartCountdownActive: boolean;
  /** Holding the fight, then released from GO until the overlay finishes; null when none runs. */
  fightStartCountdownPhase: FightStartCountdownPhase | null;
  /** Arrival versus restart presentation, retained after the disposable overlay finishes. */
  fightStartPresentation: 'entry' | 'restart';
  /** The countdown overlay with `key` has finished its exit. */
  handleFightStartCountdownFinished: (key: number) => void;
  /** Publish a post-`advanceTick()` engine state to React. Every tick-advancement path must use this. */
  publishEngineState: (state: SimulationState) => void;
  fastForwardTicks: (toTick: number) => void;
  /** Set the tutorial hold; the running tick freezes or resumes at that moment. Use this, not the engine. */
  setTutorialPaused: (paused: boolean) => void;
  handleMarkOfDarknessCast: () => void;
  handleDeathChargeCast: () => void;
  handleIndependentPrayerChange: (prayer: PrayerType) => void;
  handleOffensivePrayerChange: (prayer: PrayerType | null) => void;
  handlePrayerChange: (prayer: PrayerType | null) => void;
  handleQuickPrayerToggle: (selectedPrayers: string[]) => void;
  handleReset: () => void;
  /**
   * Enter Tutorial Mode on the current engine: a fresh run and recording with the setup's loadout,
   * under its `mechanicsConfig`, held paused. Use this rather than resetting the engine directly, which
   * would leave the recording and the live tick on the old run.
   */
  resetForTutorial: (setup: TutorialRunSetup) => void;
  handleTutorialReset: (completionOwnership: EncounterCompletionOwnership) => void;
  handleRunToggle: () => void;
  handleSceneReady: () => void;
  handleSpecialAttackToggle: () => void;
  handleSwapInventorySlots: (fromIndex: number, toIndex: number) => void;
  handleExecuteEncounterCommand: (command: EncounterCommand) => boolean;
  /**
   * The encounter's own practice session for the live run (Inferno's waves), or null in a replay
   * and in every encounter without one. Its restarts take `handleExecuteEncounterCommand`, and
   * Ctrl+R runs its primary when no replay practice start is set.
   */
  encounterSession: PracticeSessionState | null;
  /** Practice tool: set the primary boss NPC's current HP (encounter-agnostic). */
  handleSetBossHp: (hp: number) => void;
  /** Practice tool: apply a named boss-HP preset as a phase jump. */
  handleApplyBossHpPreset: (hp: number) => void;
  handleUnequipSlot: (slot: string) => void;
  handleUnequipAmmo: () => void;
  handleUseItem: (inventoryIndex: number, option?: ItemActionOption) => void;
  handleDropItem: (inventoryIndex: number) => void;
  isSceneReady: boolean;
  playerEquipmentRef: MutableRefObject<PlayerEquipment>;
  playerCombatSuppliesRef: MutableRefObject<CombatSupplies>;
  playerInventoryRef: MutableRefObject<Inventory>;
  replay: UseReplayReturn;
  replayPlayerConfig: PlayerConfig;
  instantInventoryResetToken: number;
  inputPresentation: InputPresentation;
  previewTargetTile: (target: Coordinate | null) => () => void;
  prayerPresentation: PrayerPresentation;
  quickPrayersActive: boolean;
  setEngine: Dispatch<SetStateAction<SimulationEngine>>;
  setIsSceneReady: Dispatch<SetStateAction<boolean>>;
  setSimulationState: Dispatch<SetStateAction<SimulationState>>;
  setTargetTile: Dispatch<SetStateAction<Coordinate | null>>;
  simulationState: SimulationState;
  targetTile: Coordinate | null;
  targetTileRef: MutableRefObject<Coordinate | null>;
  tickTimingRef: MutableRefObject<TickTimingMonitor>;
}

export function useSimulationWiring({
  activeMechanicsConfig,
  attackStylePerCategory,
  autoAdvance,
  pauseWhenUnfocused,
  modalPaused,
  graphicsHeld = false,
  replayPracticeUnavailableReason = null,
  replayPracticeHeld,
  fightStartCountdownTicks,
  getIntroAnimationRemainingMs,
  audioEngine,
  eventAudioPlayerRef,
  frameSoundTrackerRef,
  getEncounterEquipment,
  getEncounterInventory,
  getEncounterSupplies,
  setEncounterSupplies,
  isFullyLoaded,
  instantInventoryEnabled,
  instantPrayerEnabled,
  objTypeLoader,
  persistEquipmentEncounterKind,
  playerConfig,
  getReplayUiState,
  getReplayViewportState,
  getPresentationState,
  getOverlays,
  onReplayUiStateChange,
  rendererType,
  sceneState,
  setPlayerConfig,
  setSceneState,
  speedMultiplier,
  inputLagMs,
  updateAttackStylePerCategory,
}: UseSimulationWiringParams): UseSimulationWiringReturn {
  const focusPaused = useBackgroundSuspended(pauseWhenUnfocused);
  const focusPausedRef = useRef(focusPaused);
  focusPausedRef.current = focusPaused;
  useLayoutEffect(() => {
    animationFrames.setSuspended(focusPaused);
  }, [focusPaused]);
  useEffect(
    () => () => {
      animationFrames.setSuspended(false);
      animationFrames.clock.reset();
    },
    [],
  );
  /**
   * Whether live audio is paused for a hold (focus suspension, a covering modal or a 3D view that
   * cannot draw), so only the hold's own pause is ever resumed, once no hold applies.
   */
  const liveHoldAudioPausedRef = useRef(false);
  const [engine, setEngine] = useState<SimulationEngine>(
    () => new SimulationEngine({ encounter: new LobbyEncounter(), stats: playerConfig.stats }),
  );
  const engineRef = useRef<SimulationEngine>(engine);
  const [simulationState, setSimulationState] = useState(() => engine.getState());
  const [isSceneReady, setIsSceneReady] = useState(false);
  const handleSceneReady = useCallback(() => setIsSceneReady(true), []);
  const getReplayUiStateRef = useRef(getReplayUiState);
  getReplayUiStateRef.current = getReplayUiState;
  const playerEquipmentRef = useRef(playerConfig.equipment);
  const playerStatsRef = useRef(playerConfig.stats);
  const playerInventoryRef = useRef<Inventory>(createEmptyInventory());
  const playerCombatSuppliesRef = useRef<CombatSupplies>(createEmptyCombatSupplies());
  /**
   * The configured loadout the current run started from, before any worn gear was carried into it;
   * null when unknown (a replay takeover). A restart carries worn gear only while the configured
   * loadout still matches it, so an edit since wins outright.
   */
  const runLoadoutBaselineRef = useRef<WornLoadout | null>(null);
  const [targetTile, setTargetTile] = useState<Coordinate | null>(null);
  const targetTileRef = useRef<Coordinate | null>(null);
  const tickTimingRef = useRef(new TickTimingMonitor());
  const instantInventoryPreviewRef = useRef<InventoryEquipmentPreview | null>(null);
  const [instantInventoryResetToken, setInstantInventoryResetToken] = useState(0);
  const [protectionPrayerPreview, setProtectionPrayerPreview] = useState<PrayerSlotPreview>(NO_PRAYER_SLOT_PREVIEW);
  const [offensivePrayerPreview, setOffensivePrayerPreview] = useState<PrayerSlotPreview>(NO_PRAYER_SLOT_PREVIEW);
  const [independentPrayerPreview, setIndependentPrayerPreview] =
    useState<IndependentPrayerPreview>(NO_INDEPENDENT_PREVIEW);
  const [localPrayerBits, setLocalPrayerBits] = useState<PrayerBits>(NO_PRAYER_BITS);
  const protectionPrayerPreviewSeqRef = useRef(0);
  const offensivePrayerPreviewSeqRef = useRef(0);
  const independentPrayerPreviewSeqRef = useRef(0);
  const localPrayerBitsRef = useRef<PrayerBits>(NO_PRAYER_BITS);
  // Monotonic across resets, so a stamp from before one can never match a write
  // issued after it and retire a bit a tick early.
  const prayerBitSeqRef = useRef(0);
  const prayerBitOwnersRef = useRef<PrayerBitOwners>({});
  const predictedPrayerInputRef = useRef<PrayerInputState | null>(null);
  const predictedPrayerInputSeqRef = useRef(0);
  const prayerPredictionEnabled = instantInventoryEnabled && instantPrayerEnabled;
  const prayerPresentation = useMemo<PrayerPresentation>(() => {
    // Standard mode renders the client's own bitmask over COMMITTED state, so a
    // switch keeps the old prayer lit until the tick answers. Reading the queued
    // projection here instead would drop it the moment the input is queued —
    // which at zero input lag is the click itself.
    const protection = prayerPredictionEnabled
      ? resolvePredictedPrayer(
          protectionPrayerPreview,
          simulationState.pendingProtectionPrayer,
          simulationState.activePrayer,
        )
      : simulationState.activePrayer;
    const offensive = prayerPredictionEnabled
      ? resolvePredictedPrayer(
          offensivePrayerPreview,
          simulationState.pendingOffensivePrayer,
          simulationState.offensivePrayer,
        )
      : simulationState.offensivePrayer;
    const independent = prayerPredictionEnabled
      ? resolvePredictedIndependent(
          independentPrayerPreview,
          simulationState.pendingIndependentPrayers,
          simulationState.independentPrayers,
        )
      : simulationState.independentPrayers;
    // Bits outstanding when the setting was switched on must not layer over the
    // prediction that replaced them.
    const bits = prayerPredictionEnabled ? NO_PRAYER_BITS : localPrayerBits;
    return {
      protection,
      offensive,
      independent,
      visualOverrides: bits,
      anyLit: anyPrayerLit(protection, offensive, independent, bits),
    };
  }, [
    protectionPrayerPreview,
    offensivePrayerPreview,
    independentPrayerPreview,
    localPrayerBits,
    prayerPredictionEnabled,
    simulationState.pendingProtectionPrayer,
    simulationState.pendingOffensivePrayer,
    simulationState.activePrayer,
    simulationState.offensivePrayer,
    simulationState.pendingIndependentPrayers,
    simulationState.independentPrayers,
  ]);
  const runPreview = useSentInputPreview<boolean>();
  const [sentSpecialAttackOps, setSentSpecialAttackOps] = useState<readonly PendingInputOp[]>([]);
  const sentSpecialAttackOpsRef = useRef<readonly PendingInputOp[]>([]);
  const attackStylePreview = useSentInputPreview<number>();
  const selectedSpellPreview = useSentInputPreview<string | null>();
  const targetTilePreview = useSentInputPreviewRef<Coordinate | null>();
  const takeOverEngineRef = useRef(false);
  const prevEngineRef = useRef<SimulationEngine | null>(null);

  const inputLagBufferRef = useRef(new InputLagBuffer());
  /**
   * Active-clock time the running tick is scheduled to end, published by the
   * real-time tick loop; null while that loop is not running or its engine cannot
   * advance. The tick runs on the first animation frame at or after it, which may be later.
   */
  const nextTickBoundaryRef = useRef<number | null>(null);
  /** The running tick loop's schedule; null while the loop is stopped. */
  const liveTickScheduleRef = useRef<LiveTickSchedule | null>(null);
  /**
   * The time left in the tick when the last loop stopped (a speed change, a manual pause, a covering
   * modal, replay viewing), for the next loop to finish it. Used only by a loop on the same engine and tick, and
   * dropped when a new recording starts.
   */
  const carriedTickScheduleRef = useRef<CarriedTickSchedule | null>(null);
  const inputLagMsRef = useRef(inputLagMs);
  inputLagMsRef.current = inputLagMs;
  const autoAdvanceRef = useRef(autoAdvance);
  autoAdvanceRef.current = autoAdvance;
  const speedMultiplierRef = useRef(speedMultiplier);
  speedMultiplierRef.current = speedMultiplier;
  /** The countdown positioning session; see {@link StartPreparationSession}. */
  const startPreparationRef = useRef<StartPreparationSession | null>(null);
  /** The latest positioning step for the viewports; cleared with the session. */
  const startPositionPreparationRef = useRef<StartPositionPreparation | null>(null);
  /** Assigned once `replay` exists; replay entry commits a session before viewing begins. */
  const commitStartPreparationRef = useRef<() => void>(() => {});

  /**
   * Active-clock time at which an input sent at `sendTime` reaches the server.
   * Equal to `sendTime` when lag is off or outside real-time auto-advance play,
   * i.e. the pre-lag behavior.
   */
  const inputArrivalTime = useCallback((sendTime: number): number => {
    if (!autoAdvanceRef.current) return sendTime;
    return sendTime + inputLagWallClockDelay(inputLagMsRef.current, speedMultiplierRef.current);
  }, []);

  /**
   * Route a player input through the simulated-latency buffer. With lag off or
   * outside real-time auto-advance play the effect runs immediately — identical
   * to the pre-lag behavior. Otherwise it is held until it "reaches the server"
   * (see {@link inputLagWallClockDelay}) and applied by the first tick that runs
   * after it arrives, so a late action can slip into the following tick.
   *
   * An instant input is buffered too while earlier inputs are still buffered, so
   * it cannot overtake them, and once the scheduled boundary has passed but the
   * tick has not run yet, so the loop's strict "arrived before the tick ran" cutoff
   * decides it like any other input.
   *
   * A buffered input keeps its synthetic provenance: replay recording checks it
   * when the input is applied, after the synthetic dispatch has returned.
   */
  const dispatchInput = useCallback(
    (apply: () => void): void => {
      const sendTime = animationFrames.clock.now();
      const arrivalTime = inputArrivalTime(sendTime);
      const boundary = nextTickBoundaryRef.current;
      const engine = engineRef.current;
      const boundaryPassed =
        boundary !== null && sendTime >= boundary && engine.canAdvance() && !engine.isTutorialPaused();
      if (arrivalTime <= sendTime && !boundaryPassed && inputLagBufferRef.current.pending === 0) {
        apply();
        return;
      }
      inputLagBufferRef.current.push(arrivalTime, isSyntheticInput() ? () => runSyntheticInput(apply) : apply);
    },
    [inputArrivalTime],
  );

  const dispatchSpecialAttackInput = (op: PendingInputOp, apply: () => void): void => {
    sentSpecialAttackOpsRef.current = [...sentSpecialAttackOpsRef.current, op];
    setSentSpecialAttackOps(sentSpecialAttackOpsRef.current);
    dispatchInput(() => {
      sentSpecialAttackOpsRef.current = sentSpecialAttackOpsRef.current.filter((pending) => pending !== op);
      setSentSpecialAttackOps(sentSpecialAttackOpsRef.current);
      apply();
      setSimulationState(engineRef.current.getState());
    });
  };

  /**
   * Feed the Prayer Flick overlay: when a prayer was clicked, and when that
   * click reaches the engine. Presentation-only — the pair of active-clock stamps
   * never enters the engine, SimulationState, or the replay recording.
   */
  const recordPrayerFlickInput = useCallback(
    (kind: PrayerFlickInputKind): void => {
      const clickTime = animationFrames.clock.now();
      prayerFlickTimeline.recordClick(kind, clickTime, inputArrivalTime(clickTime));
    },
    [inputArrivalTime],
  );

  // Drop any in-flight buffered input when the wiring unmounts, so a late flush
  // can never fire against a torn-down engine.
  useEffect(() => {
    const buffer = inputLagBufferRef.current;
    return () => buffer.clear();
  }, []);

  const resetInstantInventoryPreview = useCallback(() => {
    instantInventoryPreviewRef.current = null;
    setInstantInventoryResetToken((token) => token + 1);
  }, []);

  const resetInstantPrayerPreview = useCallback(() => {
    protectionPrayerPreviewSeqRef.current += 1;
    offensivePrayerPreviewSeqRef.current += 1;
    // Independents retire through the same buffered-input callback as the two exclusive slots, so a
    // reset that discards that buffer must invalidate this preview too or Preserve stays lit.
    independentPrayerPreviewSeqRef.current += 1;
    setProtectionPrayerPreview(NO_PRAYER_SLOT_PREVIEW);
    setOffensivePrayerPreview(NO_PRAYER_SLOT_PREVIEW);
    setIndependentPrayerPreview(NO_INDEPENDENT_PREVIEW);
  }, []);

  const clearLocalPrayerBits = useCallback(() => {
    prayerBitOwnersRef.current = {};
    localPrayerBitsRef.current = NO_PRAYER_BITS;
    setLocalPrayerBits(NO_PRAYER_BITS);
  }, []);

  const resetPrayerPreview = useCallback(() => {
    resetInstantPrayerPreview();
    // The tick these bits were stamped for belongs to a run that is gone, and the
    // engine restarts its tick counter, so nothing would ever retire them.
    clearLocalPrayerBits();
    predictedPrayerInputSeqRef.current += 1;
    predictedPrayerInputRef.current = null;
  }, [clearLocalPrayerBits, resetInstantPrayerPreview]);

  const resetInputPresentation = useCallback(() => {
    runPreview.reset();
    sentSpecialAttackOpsRef.current = [];
    setSentSpecialAttackOps([]);
    attackStylePreview.reset();
    selectedSpellPreview.reset();
    targetTilePreview.reset();
  }, [attackStylePreview.reset, runPreview.reset, selectedSpellPreview.reset, targetTilePreview.reset]);

  /**
   * Show a prayer click immediately, ahead of the lagged input that actually
   * queues it. Returns the callback that retires the prediction once that input
   * reaches the engine — a newer click on the same slot supersedes it, so a
   * flick still in flight never flashes back to the older value. This replaces
   * conflicts only for Instant Prayer; normal click highlights are tracked below.
   */
  const previewPrayerSlot = useCallback(
    (
      setPreview: Dispatch<SetStateAction<PrayerSlotPreview>>,
      seqRef: MutableRefObject<number>,
      prayer: PrayerType | null,
    ): (() => void) => {
      if (!prayerPredictionEnabled) return () => {};
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      setPreview([true, prayer]);
      return () => {
        if (seqRef.current !== seq) return;
        setPreview(NO_PRAYER_SLOT_PREVIEW);
      };
    },
    [prayerPredictionEnabled],
  );

  /** {@link previewPrayerSlot} for the independent SET, which is predicted whole rather than per slot. */
  const previewIndependentPrayers = useCallback(
    (prayers: readonly PrayerType[]): (() => void) => {
      if (!prayerPredictionEnabled) return () => {};
      const seq = independentPrayerPreviewSeqRef.current + 1;
      independentPrayerPreviewSeqRef.current = seq;
      setIndependentPrayerPreview([true, prayers]);
      return () => {
        if (independentPrayerPreviewSeqRef.current !== seq) return;
        setIndependentPrayerPreview(NO_INDEPENDENT_PREVIEW);
      };
    },
    [prayerPredictionEnabled],
  );

  const isPrayerLit = useCallback((prayer: PrayerType): boolean => {
    const bit = localPrayerBitsRef.current[prayer];
    if (bit !== undefined) return bit;
    const engine = engineRef.current;
    switch (PRAYER_CATEGORIES[prayer]) {
      case 'protection':
        return engine.activePrayer === prayer;
      case 'offensive':
        return engine.offensivePrayer === prayer;
      default:
        return engine.independentPrayers.includes(prayer);
    }
  }, []);

  const litPrayersInSlot = useCallback(
    (category: PrayerCategory): PrayerType[] =>
      Object.values(PrayerType).filter((prayer) => PRAYER_CATEGORIES[prayer] === category && isPrayerLit(prayer)),
    [isPrayerLit],
  );

  /**
   * Flip the client's own prayer bits, and return the callback that stamps them
   * with the tick that will answer them.
   *
   * Bits are per prayer, never per slot: a click toggles only the prayer that was
   * clicked, so a protection switch legally shows two — or three — protections lit
   * at once until the server replies.
   * Sequence numbers keep an older stamp from claiming a newer click's bit.
   *
   * A no-op under Instant Prayer, which predicts the server's answer instead of
   * showing the client's bits; {@link previewPrayerSlot} owns that display, and
   * the two must never be live at once.
   */
  const flipPrayerBits = useCallback(
    (writes: readonly PrayerBitWrite[]): (() => void) => {
      if (prayerPredictionEnabled || writes.length === 0) return NO_SENT_STAMP;

      const owned = writes.map(({ prayer, lit }) => {
        const seq = prayerBitSeqRef.current + 1;
        prayerBitSeqRef.current = seq;
        prayerBitOwnersRef.current = { ...prayerBitOwnersRef.current, [prayer]: { seq, answeredAtTick: null } };
        localPrayerBitsRef.current = { ...localPrayerBitsRef.current, [prayer]: lit };
        return { prayer, seq };
      });
      setLocalPrayerBits(localPrayerBitsRef.current);

      // Called when the input reaches the engine, which queues it for the NEXT
      // tick to drain. Stamping the answer here rather than clearing the bit is
      // what keeps a publish that followed no tick — a zero-iteration
      // `fastForwardTicks`, or one whose final tick queued this very input — from
      // retiring a bit the server has not answered.
      return () => {
        const answeredAtTick = engineRef.current.getState().currentTick + 1;
        for (const { prayer, seq } of owned) {
          if (prayerBitOwnersRef.current[prayer]?.seq !== seq) continue;
          prayerBitOwnersRef.current = { ...prayerBitOwnersRef.current, [prayer]: { seq, answeredAtTick } };
        }
      };
    },
    [prayerPredictionEnabled],
  );

  /**
   * The bits one prayer-book click flips.
   *
   * Turning a lit prayer OFF is unconditional, but turning one ON is gated on having
   * prayer points, so a prayer clicked on with none left does not light while the
   * server refuses it (https://oldschool.runescape.wiki/w/Prayer#Prayer_points).
   * A null prayer is an explicit slot clear, which darkens all of them.
   */
  const clickedPrayerBits = useCallback(
    (category: PrayerCategory, prayer: PrayerType | null): PrayerBitWrite[] => {
      if (prayer === null) return litPrayersInSlot(category).map((lit) => ({ prayer: lit, lit: false }));
      if (isPrayerLit(prayer)) return [{ prayer, lit: false }];
      return engineRef.current.prayerState.points > 0 ? [{ prayer, lit: true }] : [];
    },
    [isPrayerLit, litPrayersInSlot],
  );

  const predictPrayerAction = useCallback((action: QueuedPrayerAction) => {
    const previous = predictedPrayerInputRef.current ?? engineRef.current.resolvePendingPrayerInput();
    const predicted = resolvePrayerActions(previous, [action], engineRef.current.prayerState.points > 0);
    const seq = predictedPrayerInputSeqRef.current + 1;
    predictedPrayerInputSeqRef.current = seq;
    predictedPrayerInputRef.current = predicted;
    return {
      predicted,
      retire: () => {
        if (predictedPrayerInputSeqRef.current === seq) predictedPrayerInputRef.current = null;
      },
    };
  }, []);

  /**
   * Publish a post-`advanceTick()` engine state to React. Every tick-advancement
   * path — the RAF loop, tutorial fast-forward, and manual (auto-advance off)
   * stepping — goes through here, because a landed gear swap only reaches the
   * player model and the loadout refs once the state carrying it is published,
   * and equipment has to follow it in the same update.
   */
  const publishEngineState = useCallback(
    (state: SimulationState) => {
      // Retiring bits inside the dispatch callback instead would clear them in
      // the click's own event at zero input lag, where that callback runs inline,
      // and they would never be drawn.
      const retired = retireAnsweredPrayerBits(
        localPrayerBitsRef.current,
        prayerBitOwnersRef.current,
        state.currentTick,
      );
      prayerBitOwnersRef.current = retired.owners;
      if (retired.changed) {
        localPrayerBitsRef.current = retired.bits;
        setLocalPrayerBits(retired.bits);
      }
      setSimulationState(state);
      setPlayerConfig((prev) =>
        equipmentEqual(state.playerEquipment, prev.equipment) ? prev : { ...prev, equipment: state.playerEquipment },
      );
    },
    [setPlayerConfig],
  );

  /**
   * Everything that must be torn down when the app stops showing a replay, whichever way it
   * leaves. Playback drives the audio engine and the sound/event trackers directly, so a route
   * out of replay that skips this carries the replay's queued audio into live play.
   */
  const resetReplayPresentation = (): void => {
    resetInstantInventoryPreview();
    resetPrayerPreview();
    resetInputPresentation();
    prayerFlickTimeline.reset();
    audioEngine.stopAll();
    frameSoundTrackerRef.current.reset();
    eventAudioPlayerRef.current.reset();
  };

  const replay = useReplay({
    practiceHeld: replayPracticeHeld,
    practiceUnavailableReason:
      replayPracticeUnavailableReason ??
      (modalPaused
        ? 'Close the dialog first.'
        : graphicsHeld
          ? 'Restore the 3D view before practicing from this replay.'
          : !isFullyLoaded || sceneState.kind !== 'encounter'
            ? 'Wait for the encounter to finish loading.'
            : engine.isTutorialPaused()
              ? 'Replay practice is unavailable during tutorials.'
              : null),
    onRetryFight: () => retryShortcut(),
    playbackHeld: focusPaused || modalPaused || graphicsHeld,
    engineRef,
    simulationState,
    getReplayUiState,
    getReplayViewportState,
    getReplayDpsProjection: () => engineRef.current.getAdjustedTheoreticalDps(),
    getPresentationState,
    getOverlays,
    speedMultiplier,
    mechanicsConfig: activeMechanicsConfig,
    objTypeLoader,
    onTakeOver: (newEngine, newState, uiState, resumeTarget) => {
      takeOverEngineRef.current = true;
      inputLagBufferRef.current.clear();
      carriedTickScheduleRef.current = null;
      tickTimingRef.current.reset();
      // Leaving replay mode, so the same presentation reset an ordinary exit performs. The
      // intro release an ordinary exit ALSO performs must not happen here: it would complete an
      // intro on the freshly reconstructed engine, which is a different engine entirely.
      resetReplayPresentation();
      // The live tick loop reads this ref on its very next tick. Left on the tile the viewer had
      // queued before they entered replay, the resumed player immediately walks away from where
      // they took over.
      setTargetTile(resumeTarget);
      targetTileRef.current = resumeTarget;
      playerInventoryRef.current = cloneInventory(newState.inventory);
      playerCombatSuppliesRef.current = newState.playerCombatSupplies;
      playerEquipmentRef.current = newState.playerEquipment;
      // The recording does not say which configured loadout its run started from.
      runLoadoutBaselineRef.current = null;
      onReplayUiStateChange(uiState);
      setEngine(newEngine);
      setSimulationState(newState);
      restartLiveTickSchedule();
      if (autoAdvanceRef.current) {
        setFightStartPresentation('restart');
        startFightStartCountdown('restored');
      }
      setPlayerConfig((prev) => {
        const eq = newState.playerEquipment;
        if (!equipmentEqual(eq, prev.equipment)) return { ...prev, equipment: eq };
        return prev;
      });
      window.dispatchEvent(new CustomEvent('tutorial:replay-exited'));
    },
    onEnterReplay: () => {
      // Viewing is not live execution, but leaving it is, without another countdown.
      commitStartPreparationRef.current();
      resetInstantInventoryPreview();
      resetPrayerPreview();
      resetInputPresentation();
      inputLagBufferRef.current.clear();
      prayerFlickTimeline.reset();
      audioEngine.stopAll();
      eventAudioPlayerRef.current.reset();
    },
    onExitReplay: () => {
      resetReplayPresentation();
      // Release a landing intro that was never allowed to finish.
      //
      // A LOADED replay enters a brand-new encounter and flips into replay mode
      // immediately, so the intro-complete signal arrived while `replayMode` was
      // true and `handleIntroComplete` dropped it — and the intro overlay that
      // would raise it again only renders outside replay mode, so nothing ever
      // completed it. `canAdvance()` gates on the intro, which left the run stuck
      // at tick 0 refusing both the tick loop and world clicks the moment the
      // viewer exited. A locally recorded replay never hit this: its intro had
      // finished long before replay mode began.
      if (engineRef.current.getState().introActive) {
        engineRef.current.completeIntro();
      }
      setSimulationState(engineRef.current.getState());
      window.dispatchEvent(new CustomEvent('tutorial:replay-exited'));
    },
    onSeek: () => {
      resetInstantInventoryPreview();
      resetPrayerPreview();
      resetInputPresentation();
      prayerFlickTimeline.reset();
      audioEngine.stopAll();
      frameSoundTrackerRef.current.reset();
      eventAudioPlayerRef.current.reset();
    },
    onPause: () => {
      audioEngine.pausePlayback();
    },
    onResume: () => {
      audioEngine.resumePlayback();
    },
    onPlaybackEnd: () => {
      eventAudioPlayerRef.current.finishReplay(speedMultiplierRef.current);
    },
  });

  const replayPlayerConfig = useMemo(
    () =>
      replay.replayMode
        ? {
            ...playerConfig,
            equipment: replay.displayState.playerEquipment,
          }
        : playerConfig,
    [playerConfig, replay.displayState.playerEquipment, replay.replayMode],
  );

  // The walk's permission as the run's setup stands now: a tick-0 edit (a typed start wave) moves it.
  const countdownMovementAllowed = encounterOffersCountdownMovement(
    engine.getEncounterKind(),
    simulationState.mechanicsConfig,
  );
  const fightStartCountdown = useFightStartCountdown({
    // A manually stepped fight has no real-time start to count down to, and its step would not wait.
    countdownTicks: !autoAdvance ? null : fightStartCountdownTicks,
    speedMultiplier,
    covered: modalPaused || focusPaused || graphicsHeld,
    introActive: simulationState.introActive,
    waitForIntro: countdownMovementAllowed,
    getIntroRemainingMs: (expectedSpeedMultiplier) => getIntroAnimationRemainingMs?.(expectedSpeedMultiplier),
  });
  const countdownTicksRef = useRef<number | null>(null);
  countdownTicksRef.current = autoAdvance ? fightStartCountdownTicks : null;
  const countdownRunRef = useRef<CountdownRun | null>(null);
  const consumedCountdownKeyRef = useRef<number | null>(null);
  /** Close the positioning session without committing it: its run is being replaced or left. */
  const dropStartPreparation = useCallback(() => {
    startPreparationRef.current = null;
    startPositionPreparationRef.current = null;
  }, []);
  /**
   * Close the positioning session, starting its run on the chosen tile. Every way out of a session
   * into live execution (GO, the countdown turned off, manual stepping, replay viewing, a fast-forward)
   * comes through here first, so tick 1 and the recording both see the committed start.
   */
  const commitStartPreparation = useCallback(() => {
    const session = startPreparationRef.current;
    if (!session) return;
    dropStartPreparation();
    if (!session.offered) return;
    const engine = session.engine;
    if (engine !== engineRef.current || engine.currentTick !== SIMULATION_START_TICK || engine.getIntroActive()) return;
    engine.finalizeStartPosition();
    const state = engine.getState();
    replay.finalizeFreshStart({ position: state.playerPosition, facingAngle: state.playerFacingAngle });
    setSimulationState(state);
  }, [dropStartPreparation, replay.finalizeFreshStart]);
  commitStartPreparationRef.current = commitStartPreparation;
  /**
   * `fresh` is a run starting from its opening (entry, Restart, an encounter's fresh restart);
   * `restored` is a reconstructed boundary, which never moves even when it is tick 0.
   */
  const startFightStartCountdown = useCallback(
    (provenance: 'fresh' | 'restored') => {
      const run: CountdownRun = {
        engine: engineRef.current,
        tick: engineRef.current.currentTick,
        key: null,
        released: false,
      };
      countdownRunRef.current = run;
      dropStartPreparation();
      // A restored boundary never moves; a fresh one opens a session the live permission gates.
      if (provenance === 'fresh' && countdownTicksRef.current !== null && run.tick === SIMULATION_START_TICK) {
        startPreparationRef.current = {
          run,
          engine: run.engine,
          boundary: {},
          cadence: null,
          sequence: 0,
          // Read from the engine, not the last render: a restart has only just set up this run.
          offered: encounterOffersCountdownMovement(run.engine.getEncounterKind(), run.engine.getMechanicsConfig()),
        };
      }
      fightStartCountdown.start();
    },
    [fightStartCountdown.start, dropStartPreparation],
  );
  const cancelFightStartCountdown = useCallback(() => {
    countdownRunRef.current = null;
    dropStartPreparation();
    fightStartCountdown.cancel();
  }, [fightStartCountdown.cancel, dropStartPreparation]);
  useEffect(() => {
    if (replay.replayMode) cancelFightStartCountdown();
  }, [replay.replayMode, cancelFightStartCountdown]);
  useLayoutEffect(() => {
    const run = countdownRunRef.current;
    if (!run) return;
    if (run.engine !== engine || sceneState.kind !== 'encounter') {
      dropStartPreparation();
      countdownRunRef.current = null;
      return;
    }
    if (fightStartCountdownTicks === null || !autoAdvance || replay.replayMode) {
      // The run goes on without its countdown: start it where the player has walked to.
      commitStartPreparation();
      countdownRunRef.current = null;
      return;
    }
    const descriptor = fightStartCountdown.descriptor;
    if (!descriptor) return;
    if (descriptor.releasedAtMs === null) {
      run.key = descriptor.key;
      run.released = false;
    } else if (run.key === descriptor.key) {
      run.released = true;
    }
  }, [
    engine,
    sceneState.kind,
    fightStartCountdownTicks,
    autoAdvance,
    replay.replayMode,
    fightStartCountdown.descriptor,
    commitStartPreparation,
    dropStartPreparation,
  ]);
  const [fightStartPresentation, setFightStartPresentation] = useState<'entry' | 'restart'>('entry');

  engineRef.current = engine;

  /** Run what is left of a frozen tick from `atMs`, with the recorder picking its clock up there too. */
  const activateLiveTickSchedule = useCallback(
    (schedule: LiveTickSchedule, atMs: number): void => {
      schedule.boundaryMs = atMs + (schedule.frozenRemainingMs ?? schedule.intervalMs);
      schedule.frozenRemainingMs = null;
      nextTickBoundaryRef.current = schedule.boundaryMs;
      replay.anchorLiveClock(atMs, schedule.speedMultiplier);
    },
    [replay.anchorLiveClock],
  );

  /** Stop timing the tick at `atMs`, keeping what is left of it, with the recorder's clock held there too. */
  const freezeLiveTickSchedule = useCallback(
    (schedule: LiveTickSchedule, atMs: number): void => {
      if (schedule.frozenRemainingMs !== null) return;
      schedule.frozenRemainingMs = schedule.boundaryMs - atMs;
      nextTickBoundaryRef.current = null;
      replay.releaseLiveClock(atMs);
    },
    [replay.releaseLiveClock],
  );

  /**
   * Freeze or resume the schedule at `atMs` to match whether its engine can advance. Called by
   * every frame, after every tick (the tick or a subscriber can stop the engine) and by every
   * wiring-owned pause, so a pause is excluded from the moment it starts.
   */
  const syncLiveTickSchedule = useCallback(
    (schedule: LiveTickSchedule, atMs: number): void => {
      // Swapped in, but its recording has not started yet; the swap restarts this schedule.
      if (schedule.engine !== engineRef.current) return;
      if (!engineCanRun(schedule.engine)) freezeLiveTickSchedule(schedule, atMs);
      else if (schedule.frozenRemainingMs !== null) activateLiveTickSchedule(schedule, atMs);
    },
    [activateLiveTickSchedule, freezeLiveTickSchedule],
  );

  /**
   * The recording has moved on without the loop (reset, a new engine, a fast-forward's stepped
   * frames): the next live tick is a full interval from now, and the recorder's clock starts now
   * with it. Any time carried from a stopped loop's tick is dropped. Until the loop can time the
   * tick (an intro, a tutorial hold, manual stepping, the loop not running), the recorder's idle
   * clock holds the new frame at its start.
   */
  const restartLiveTickSchedule = useCallback((): void => {
    countdownRunRef.current = null;
    dropStartPreparation();
    carriedTickScheduleRef.current = null;
    const schedule = liveTickScheduleRef.current;
    if (!schedule) return;
    schedule.engine = engineRef.current;
    schedule.countdownKey = null;
    schedule.frozenRemainingMs = schedule.intervalMs;
    nextTickBoundaryRef.current = null;
    if (engineCanRun(schedule.engine)) activateLiveTickSchedule(schedule, animationFrames.clock.now());
  }, [activateLiveTickSchedule, dropStartPreparation]);

  const resumeHeldLiveAudio = useCallback(() => {
    if (!liveHoldAudioPausedRef.current) return;
    liveHoldAudioPausedRef.current = false;
    audioEngine.resumePlayback();
  }, [audioEngine]);

  /** The live audio hold's inputs as last synced, for the re-checks a same-engine change makes. */
  const liveAudioHoldInputsRef = useRef<LiveAudioHoldInputs>({ replayMode: false, loopEnabled: false, held: false });

  /**
   * Bring live audio in line with the holds. Only a running fight's audio follows them: a fight that
   * is not running (paused by the user, held by a tutorial, in its intro, still loading) keeps its
   * audio as it is, both when a hold starts and when it ends, so audio a hold paused stays paused
   * until the fight runs again. Called whenever any of that changes: by the effect below for what a
   * render publishes, and directly by the same-engine changes it cannot see (a tutorial hold, a reset).
   */
  const syncLiveAudioHold = useCallback(
    (inputs: LiveAudioHoldInputs, engine: SimulationEngine): void => {
      liveAudioHoldInputsRef.current = inputs;
      if (inputs.replayMode) {
        liveHoldAudioPausedRef.current = false;
        return;
      }
      if (!inputs.loopEnabled || !engineCanRun(engine)) return;
      if (inputs.held) {
        if (!liveHoldAudioPausedRef.current) audioEngine.pausePlayback();
        liveHoldAudioPausedRef.current = true;
      } else {
        resumeHeldLiveAudio();
      }
    },
    [audioEngine, resumeHeldLiveAudio],
  );

  /**
   * Set the tutorial hold. Every tutorial pause and resume goes through here, not the engine, so
   * the running tick freezes, or resumes, at the moment it changes rather than on the next frame,
   * and live audio follows a fight that a released hold has set running under another hold.
   */
  const setTutorialPaused = useCallback(
    (paused: boolean): void => {
      engineRef.current.setTutorialPaused(paused);
      const schedule = liveTickScheduleRef.current;
      if (schedule) syncLiveTickSchedule(schedule, animationFrames.clock.now());
      syncLiveAudioHold(liveAudioHoldInputsRef.current, engineRef.current);
    },
    [syncLiveTickSchedule, syncLiveAudioHold],
  );

  // Dev console helper: `window.dumpInventory()` prints the live inventory +
  // equipment as a copyable text grid and a paste-ready
  // `parseInventoryFromSetup([...])` block (see src/debug/dumpLoadout.ts), and
  // copies it to the clipboard when available. Dev builds only, so production
  // installs no global and drops the formatter.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.dumpInventory = (): string => {
      const state = engineRef.current.getState();
      const out = formatLoadout(state.inventory, state.playerEquipment, (id) => {
        try {
          return resolveEquipmentItemName(id, objTypeLoader?.load(id)?.name, `Item ${id}`);
        } catch {
          return `Item ${id}`;
        }
      });
      console.log(out);
      // Clipboard copy is best-effort: it can reject when the document lacks
      // focus or clipboard permission. The console output is the source of truth.
      void navigator.clipboard
        ?.writeText(out)
        .then(() => console.log('[dumpInventory] copied to clipboard'))
        .catch(() => {});
      return out;
    };
    return () => {
      delete window.dumpInventory;
    };
  }, [objTypeLoader]);

  useEffect(() => {
    if (!instantInventoryEnabled) {
      resetInstantInventoryPreview();
      setSimulationState(engineRef.current.getState());
    }
  }, [instantInventoryEnabled, resetInstantInventoryPreview]);

  useEffect(() => {
    // Instant Prayer is togglable mid-fight, and the two display models are
    // exclusive: whichever one the switch turned off leaves nothing behind for
    // the other to render underneath.
    if (prayerPredictionEnabled) clearLocalPrayerBits();
    else resetInstantPrayerPreview();
  }, [clearLocalPrayerBits, prayerPredictionEnabled, resetInstantPrayerPreview]);

  useEffect(() => {
    const currentEngine = engine;
    const isNewEngine = prevEngineRef.current !== currentEngine;
    prevEngineRef.current = currentEngine;

    if (isNewEngine) {
      // A swapped engine (encounter change or replay takeover) invalidates any
      // input still parked in the latency buffer: those closures captured the
      // previous engine + scene, so flushing them against the new engine would
      // mutate it and persist supplies under the previous encounter's key.
      inputLagBufferRef.current.clear();
      prayerFlickTimeline.reset();
      resetInputPresentation();
    }

    if (isNewEngine && takeOverEngineRef.current) {
      takeOverEngineRef.current = false;
      // handleTakeOver already reconstructed the engine and forked the recording onto the
      // resumed branch. Re-seeding the loadout or calling startRun here would overwrite the
      // reconstructed mid-fight state with the run's opening loadout, and throw away the prefix
      // the fork exists to keep.
      return;
    }

    // The loadout trio is seeded onto a NEW engine only. The refs hold the
    // loadout React last handed the engine; once a fight is running the engine
    // owns the live loadout (gear swaps, eaten food, fired ammo) and the refs
    // are mirrored from it. Re-applying the trio to a running engine — this
    // effect also fires when attackStylePerCategory or speedMultiplier (via
    // replay.startRun's identity) changes — used to rewind the inventory to a
    // stale snapshot while leaving the live equipment on, so gear swapped in
    // mid-fight showed up both worn AND back in the inventory, and the gear it
    // replaced disappeared entirely.
    if (isNewEngine) {
      // Saved preferences seed fresh runs. A resumed run owns its reconstructed category map;
      // subsequent style changes go through the recorded player-input handler instead.
      currentEngine.setAttackStylePerCategory(attackStylePerCategory);
      currentEngine.setInventory(playerInventoryRef.current);
      currentEngine.setEquipment(playerEquipmentRef.current);
      currentEngine.setCombatSupplies(playerCombatSuppliesRef.current);
      runLoadoutBaselineRef.current = {
        equipment: playerEquipmentRef.current,
        inventory: cloneInventory(playerInventoryRef.current),
      };
      resetInstantInventoryPreview();
      resetPrayerPreview();
      currentEngine.applyPrepotEffects();
      const initState = currentEngine.getState();
      replay.startRun(currentEngine.getRunConfig(), initState, getReplayUiStateRef.current());
      restartLiveTickSchedule();
      setSimulationState(initState);
    } else {
      setSimulationState(currentEngine.getState());
    }
  }, [
    engine,
    attackStylePerCategory,
    replay.startRun,
    restartLiveTickSchedule,
    resetInstantInventoryPreview,
    resetInputPresentation,
    resetPrayerPreview,
  ]);

  useEffect(() => {
    engineRef.current.setMechanicsConfig(activeMechanicsConfig);
    setSimulationState(engineRef.current.getState());
  }, [activeMechanicsConfig]);

  // Mirror the engine's live loadout into the refs that seed a fresh engine. The
  // engine owns the loadout once a fight is running (gear swaps, eaten food,
  // fired ammo); the per-encounter loadout store owns the STARTING loadout. Keep
  // all three refs on the same published snapshot, or a later seed (encounter /
  // lobby build, Tutorial Mode entry, cache bootstrap) pairs one snapshot's
  // equipment with another's inventory — duplicating the swapped-in item and
  // erasing the one it replaced.
  // Declared BEFORE the playerConfig effect below so an explicit equipment
  // change (preset pick, Try Again) still wins within the same commit. The
  // inventory is cloned so the ref never aliases the engine's own array.
  useEffect(() => {
    if (replay.replayMode) return;
    playerInventoryRef.current = cloneInventory(simulationState.inventory);
    playerEquipmentRef.current = simulationState.playerEquipment;
    playerCombatSuppliesRef.current = simulationState.playerCombatSupplies;
  }, [simulationState, replay.replayMode]);

  useEffect(() => {
    playerEquipmentRef.current = playerConfig.equipment;
    resetInstantInventoryPreview();
    if (!isFullyLoaded || !persistEquipmentEncounterKind) return;
    engineRef.current.setEquipment(playerConfig.equipment);
    // NOTE: we intentionally do NOT persist playerConfig.equipment back into the
    // per-encounter loadout store here. This effect fires for in-fight equipment
    // changes (gear swaps) too, and persisting them — without the matching
    // inventory — would mutate the saved STARTING loadout into a non-preset value,
    // which then snapped to the first preset on Try Again / refresh / re-entry.
    // Explicit preset selection persists via EncounterPanel's onEquipmentChange.
    setSimulationState(engineRef.current.getState());
  }, [playerConfig.equipment, isFullyLoaded, persistEquipmentEncounterKind, resetInstantInventoryPreview]);

  useEffect(() => {
    if (playerStatsRef.current === playerConfig.stats) return;
    playerStatsRef.current = playerConfig.stats;
    engineRef.current.setPlayerStats(playerConfig.stats);
    setSimulationState(engineRef.current.getState());
  }, [playerConfig.stats]);

  // Scene-ready is signaled by the viewport once its first frame is built.
  // With `rendererType: 'none'` (the UI harness) no viewport ever mounts, so the
  // scene is ready the moment the engine exists — otherwise an encounter would
  // sit in `loading` forever and never publish ticks.
  const sceneReady = isSceneReady || rendererType === 'none';

  useEffect(() => {
    if (sceneState.kind === 'loading' && sceneReady) {
      setSceneState({ kind: 'encounter', encounterKind: sceneState.targetEncounter });
      setFightStartPresentation('entry');
      startFightStartCountdown('fresh');
    } else if (sceneState.kind !== 'encounter') {
      // Left for the lobby, or for another encounter that will count down when it is ready.
      cancelFightStartCountdown();
      setFightStartPresentation('entry');
    }
  }, [sceneState, sceneReady, setSceneState, startFightStartCountdown, cancelFightStartCountdown]);

  useEffect(() => {
    syncLiveAudioHold(
      {
        replayMode: replay.replayMode,
        loopEnabled:
          autoAdvance &&
          isFullyLoaded &&
          !simulationState.introActive &&
          !fightStartCountdown.holding &&
          !(rendererType === 'webgl' && !isSceneReady),
        // Restoration uses the same balanced live hold as focus and modals. Replay pause remains
        // transport-owned, so a refused takeover leaves playback paused rather than resuming it.
        held: focusPaused || modalPaused || graphicsHeld || replay.replayPractice.busy,
      },
      engine,
    );
  }, [
    syncLiveAudioHold,
    focusPaused,
    modalPaused,
    graphicsHeld,
    autoAdvance,
    isFullyLoaded,
    simulationState.introActive,
    fightStartCountdown.holding,
    rendererType,
    isSceneReady,
    engine,
    replay.replayMode,
    replay.replayPractice.busy,
  ]);

  /** One positioning step: arrived inputs, then the walk toward the current move target. */
  const stepStartPreparation = useCallback((session: StartPreparationSession, callbackMs: number): void => {
    const steppedAtMs = animationFrames.clock.now(callbackMs);
    inputLagBufferRef.current.flush(steppedAtMs);
    const engine = session.engine;
    if (
      startPreparationRef.current !== session ||
      engineRef.current !== engine ||
      engine.currentTick !== SIMULATION_START_TICK ||
      engine.getIntroActive()
    ) {
      return;
    }
    // An NPC click clears the target, so the player stands still here rather than chasing.
    const step = engine.prepareStartPosition(targetTileRef.current ?? engine.getState().playerPosition);
    if (!step) return;
    session.sequence += 1;
    startPositionPreparationRef.current = { boundary: session.boundary, sequence: session.sequence, step, steppedAtMs };
    setSimulationState(engine.getState());
  }, []);

  /**
   * Countdown positioning: while a fresh run's numbered count is timed and uncovered, one ground-walk
   * step at each full countdown interval strictly before GO. Inputs that have arrived are delivered
   * first, as a tick would take them; nothing else runs, so the tick, NPCs, combat, prayer, energy,
   * timers, tick bus, Prayer Flick window, tick timing and recording all wait for GO, which runs the
   * ordinary first tick once. A late frame takes one step and skips the boundaries it missed; a cover
   * or tempo change re-arms the countdown, which restarts this cadence from the kept tile.
   */
  const timedCountdown = fightStartCountdown.descriptor?.releasedAtMs === null ? fightStartCountdown.descriptor : null;
  const preparationKey = timedCountdown?.key ?? null;
  const preparationStartsAtMs = timedCountdown?.startsAtMs ?? 0;
  const preparationTickMs = timedCountdown?.tickMs ?? 0;
  const preparationTickCount = timedCountdown?.tickCount ?? 0;
  const preparationCovered = modalPaused || focusPaused || graphicsHeld;
  useEffect(() => {
    const session = startPreparationRef.current;
    if (session && countdownMovementAllowed) session.offered = true;
    // Withdrawing the permission (the setting, or a setup edit) stops the walk; GO still starts the
    // run where it got to.
    if (
      !session ||
      !countdownMovementAllowed ||
      preparationKey === null ||
      preparationCovered ||
      replay.replayMode ||
      !autoAdvance ||
      simulationState.introActive ||
      session.engine !== engine ||
      countdownRunRef.current !== session.run ||
      session.run.key !== preparationKey
    ) {
      return;
    }
    if (session.cadence?.key !== preparationKey) session.cadence = { key: preparationKey, nextIndex: 1 };
    const cadence = session.cadence;
    let frameId: number | null = null;
    const frame = () => {
      frameId = null;
      if (startPreparationRef.current !== session || cadence.nextIndex >= preparationTickCount) return;
      const callbackMs = performance.now();
      if (
        document.visibilityState !== 'hidden' &&
        callbackMs >= preparationStartsAtMs + cadence.nextIndex * preparationTickMs
      ) {
        stepStartPreparation(session, callbackMs);
        cadence.nextIndex = Math.max(
          cadence.nextIndex + 1,
          Math.floor((callbackMs - preparationStartsAtMs) / preparationTickMs) + 1,
        );
        if (cadence.nextIndex >= preparationTickCount) return;
      }
      frameId = animationFrames.request(frame);
    };
    frameId = animationFrames.request(frame);
    return () => {
      if (frameId !== null) animationFrames.cancel(frameId);
    };
  }, [
    preparationKey,
    preparationStartsAtMs,
    preparationTickMs,
    preparationTickCount,
    preparationCovered,
    countdownMovementAllowed,
    replay.replayMode,
    autoAdvance,
    simulationState.introActive,
    engine,
    stepStartPreparation,
  ]);

  // Manual stepping never flushes the buffer, so inputs still held when
  // auto-advance turns off are applied now, in order, before newer ones.
  useEffect(() => {
    if (!autoAdvance) inputLagBufferRef.current.flush(Number.POSITIVE_INFINITY);
  }, [autoAdvance]);

  /**
   * The real-time tick loop, on the active (suspension-excluding) clock. One rule, which the
   * input-lag flush, `nextTickBoundaryRef` for {@link dispatchInput}, the Prayer Flick tick
   * window, the tick timing monitor and the replay recorder all follow:
   *
   * - The first animation frame at or after the scheduled boundary runs the tick, then and there.
   *   A frame that arrives late makes the tick late, and the tick before it longer, the way a
   *   lagging server's tick is; nothing is shortened to make up for it.
   * - The tick takes every input that arrived strictly before it actually ran, including those
   *   from the late stretch.
   * - The next boundary is one full interval after the tick actually ran.
   * - Time the tick is not running is excluded from it: suspended time by the clock, and time the
   *   engine cannot advance (a tutorial hold) or the loop is stopped (a manual pause, a covering
   *   modal, a 3D view that cannot draw, the start-of-fight countdown, a speed change, replay
   *   viewing) by freezing what is left of the tick and finishing it afterwards.
   *   Each freeze starts when the pause does: a tick or its subscribers stopping the engine
   *   freeze at that tick's run time, {@link setTutorialPaused} at its call, the loop stopping in
   *   its cleanup. Only a pause set straight on the engine waits for the next frame to find it.
   *   The recorder freezes and resumes with it, so every tick's frame lasts its interval plus
   *   exactly the lateness recorded for the next one, and no paused time reaches the replay.
   * - A new recording normally starts a full tick from then. A genuine countdown release
   *   instead runs tick 1 in that release turn for a fresh fight. A restored boundary opens a
   *   full input interval at GO, without spending the next simulation tick before the player acts.
   */
  useLayoutEffect(() => {
    if (
      !autoAdvance ||
      replay.replayPractice.busy ||
      modalPaused ||
      graphicsHeld ||
      !isFullyLoaded ||
      simulationState.introActive ||
      fightStartCountdown.holding ||
      (rendererType === 'webgl' && !isSceneReady) ||
      replay.replayMode
    ) {
      return;
    }
    // Live execution starts here (GO, or the countdown ending another way): from the chosen tile.
    commitStartPreparation();
    const carried = carriedTickScheduleRef.current;
    carriedTickScheduleRef.current = null;

    const tickIntervalMs = 600 / speedMultiplier;
    tickTimingRef.current.setExpectedMs(tickIntervalMs);
    tickTimingRef.current.reset();
    // Wall-clock entry of the previous callback, kept with a late tick. Unknown across a
    // suspension or a hidden stretch, which are not frame gaps.
    let lastCallbackMs: number | null = null;
    const unsubscribeResume = animationFrames.subscribeResume(() => {
      tickTimingRef.current.reset();
      lastCallbackMs = null;
    });

    let animationFrameId: number | null = null;
    let running = true;
    const startMs = animationFrames.clock.now();
    const startEngine = engineRef.current;
    const countdownRun = countdownRunRef.current;
    const countdownKey = countdownRun?.key ?? null;
    const countdownRelease =
      countdownRun?.released === true &&
      countdownKey !== null &&
      consumedCountdownKeyRef.current !== countdownKey &&
      countdownRun.engine === startEngine &&
      countdownRun.tick === startEngine.currentTick;
    const restoredRelease =
      countdownRelease &&
      replay.restoredPresentation?.engine === startEngine &&
      replay.restoredPresentation.tick === countdownRun.tick;
    const countdownFirstTick = countdownRelease && !restoredRelease;
    // This release owns the interval being scheduled now, not the eventual tick. Reinstalling
    // the loop during that interval must carry its remainder rather than spend GO again.
    if (restoredRelease) consumedCountdownKeyRef.current = countdownKey;
    const remainingMs = countdownFirstTick
      ? 0
      : carried &&
          carried.countdownKey === null &&
          carried.engine === startEngine &&
          carried.tick === startEngine.currentTick
        ? continuedRemainingMs(carried, tickIntervalMs)
        : tickIntervalMs;
    const schedule: LiveTickSchedule = {
      boundaryMs: startMs + remainingMs,
      intervalMs: tickIntervalMs,
      speedMultiplier,
      engine: startEngine,
      countdownKey: countdownFirstTick ? countdownKey : null,
      frozenRemainingMs: remainingMs,
    };
    liveTickScheduleRef.current = schedule;
    nextTickBoundaryRef.current = null;
    if (engineCanRun(startEngine)) activateLiveTickSchedule(schedule, startMs);

    const tick = (timestamp: number) => {
      if (!running) return;
      const callbackMs = performance.now();
      if (document.visibilityState === 'hidden') {
        lastCallbackMs = null;
        animationFrameId = animationFrames.request(tick);
        return;
      }
      const rafGapMs = lastCallbackMs === null ? undefined : callbackMs - lastCallbackMs;
      lastCallbackMs = callbackMs;
      // Callback entry, not the frame timestamp: an input dispatched earlier in this frame was
      // stamped on this same clock, and anything stamped before now is in this tick.
      const ranAtMs = animationFrames.clock.now(callbackMs);
      const engine = engineRef.current;

      // A canceled/replaced run must never spend an old release against another run.
      if (
        schedule.countdownKey !== null &&
        (countdownRunRef.current !== countdownRun ||
          countdownRunRef.current?.key !== schedule.countdownKey ||
          engine !== startEngine ||
          engine.currentTick !== countdownRun?.tick)
      ) {
        schedule.countdownKey = null;
        if (schedule.engine === startEngine && schedule.boundaryMs <= ranAtMs) {
          schedule.frozenRemainingMs = tickIntervalMs;
        }
      }

      // A pause made outside the wiring (straight on the engine) is caught here, at worst a frame late.
      syncLiveTickSchedule(schedule, ranAtMs);
      if (engine === schedule.engine && schedule.frozenRemainingMs === null) {
        if (ranAtMs >= schedule.boundaryMs) {
          const scheduledMs = schedule.countdownKey !== null ? ranAtMs : schedule.boundaryMs;
          tickTimingRef.current.recordTick();
          schedule.boundaryMs = ranAtMs + tickIntervalMs;
          // Published before the tick's inputs are applied and its subscribers run, so an input
          // they dispatch is measured against the tick that has just started.
          nextTickBoundaryRef.current = schedule.boundaryMs;

          const workStartMs = performance.now();
          resumeHeldLiveAudio();
          // Deliver player inputs that reached the server before this tick actually ran,
          // then read the move target and advance.
          inputLagBufferRef.current.flush(ranAtMs);
          const currentState = engine.getState();
          const moveTarget = targetTileRef.current ?? currentState.playerPosition;
          engine.advanceTick(moveTarget);
          // A busy player's clicks are dropped, so its walk does not resume once the player is free.
          if (engine.didLastTickDiscardWalkTarget()) targetTileRef.current = null;
          const newState = engine.getState();
          if (schedule.countdownKey !== null && newState.currentTick > currentState.currentTick) {
            consumedCountdownKeyRef.current = schedule.countdownKey;
            schedule.countdownKey = null;
          }
          const tickEvents = engine.getLastTickEvents();
          replay.recordFrame(newState.currentTick, moveTarget, newState, tickEvents, {
            uiState: getReplayUiStateRef.current(),
            recordedAtMs: timestamp,
            liveTick: { ranAtMs, speedMultiplier },
          });
          resetInstantInventoryPreview();
          publishEngineState(newState);
          tickBus.publish(newState.currentTick, tickEvents);
          // The tick window the Prayer Flick bars are measured against. This
          // loop owns that clock, so it is published from here rather than
          // reconstructed from a tick number after the fact.
          prayerFlickTimeline.recordTickWindow(newState.currentTick, ranAtMs, tickIntervalMs);
          replay.recordFrameTiming({
            lateByMs: ranAtMs - scheduledMs,
            ...(rafGapMs === undefined ? {} : { rafGapMs }),
            tickWorkMs: performance.now() - workStartMs,
          });
          // The tick itself (the fight ending) or one of its subscribers (a tutorial hold) can stop
          // the engine. Freeze now, at the tick's run time, not when a later frame notices: that
          // frame can be long after, and the gap would come back as lateness on the resumed tick.
          syncLiveTickSchedule(schedule, ranAtMs);
        }
      }

      animationFrameId = animationFrames.request(tick);
    };

    if (schedule.countdownKey !== null && document.visibilityState === 'visible' && !focusPausedRef.current) {
      // The callback owns the complete tick sequence and schedules its own next RAF.
      tick(performance.now());
    } else {
      animationFrameId = animationFrames.request(tick);
    }

    return () => {
      running = false;
      const stoppedAtMs = animationFrames.clock.now();
      carriedTickScheduleRef.current = {
        remainingMs: schedule.frozenRemainingMs ?? schedule.boundaryMs - stoppedAtMs,
        intervalMs: tickIntervalMs,
        engine: schedule.engine,
        tick: schedule.engine.currentTick,
        countdownKey: schedule.countdownKey,
      };
      if (liveTickScheduleRef.current === schedule) liveTickScheduleRef.current = null;
      nextTickBoundaryRef.current = null;
      replay.releaseLiveClock(stoppedAtMs);
      unsubscribeResume();
      if (animationFrameId !== null) {
        animationFrames.cancel(animationFrameId);
      }
    };
  }, [
    autoAdvance,
    modalPaused,
    graphicsHeld,
    resumeHeldLiveAudio,
    speedMultiplier,
    isFullyLoaded,
    isSceneReady,
    rendererType,
    simulationState.introActive,
    fightStartCountdown.holding,
    replay.replayMode,
    replay.restoredPresentation,
    replay.recordFrame,
    replay.releaseLiveClock,
    replay.replayPractice.busy,
    replay.recordFrameTiming,
    activateLiveTickSchedule,
    syncLiveTickSchedule,
    resetInstantInventoryPreview,
    publishEngineState,
    commitStartPreparation,
  ]);

  /**
   * The new run's worn gear and inventory: `loadout`'s, with the gear `worn` at the restart carried
   * over (`carryWornEquipment`) where the restarted run offers countdown movement (the same encounter
   * policy; the Inferno's waves 1–68) and `loadout` is still the configured loadout the replaced run
   * started from. Supplies are never carried. Read on the reset engine.
   */
  const carriedRunLoadout = (loadout: RunLoadout, worn: PlayerEquipment): WornLoadout => {
    const baseline = runLoadoutBaselineRef.current;
    const engine = engineRef.current;
    const keeps =
      baseline !== null &&
      equipmentEqual(baseline.equipment, loadout.equipment) &&
      inventoryEqual(baseline.inventory, loadout.inventory) &&
      encounterOffersCountdownMovement(engine.getEncounterKind(), engine.getMechanicsConfig());
    return keeps ? carryWornEquipment(loadout, worn) : loadout;
  };

  /**
   * Start a fresh run on the current engine with `loadout`: pending inputs, previews and audio
   * dropped, a new recording, and the live tick restarted from now. `configure` runs on the reset
   * engine before the recording starts, so the run config the replay keeps includes what it sets.
   * `keepWornEquipment` carries the gear worn now into the new run (see {@link carriedRunLoadout}).
   */
  const resetRun = (
    loadout: RunLoadout,
    configure?: () => void,
    practiceRestart?: EncounterPracticeRestart,
    start?: Coordinate,
    keepWornEquipment = false,
  ): void => {
    tickTimingRef.current.reset();
    inputLagBufferRef.current.clear();
    prayerFlickTimeline.reset();
    eventAudioPlayerRef.current.reset();
    frameSoundTrackerRef.current.reset();
    audioEngine.stopAll();
    // That lifted any hold's pause too; the hold is re-applied to the new run below.
    liveHoldAudioPausedRef.current = false;
    // Read before the reset, which replaces the run whose gear this is.
    const worn = keepWornEquipment ? engineRef.current.getState().playerEquipment : null;
    // The run's recorded start, so a replay of it opens on the same tile; omitted, the default.
    const startPosition = start ? ([...start] as Coordinate) : undefined;
    if (practiceRestart?.encounterSeeds) {
      // Seeds only, no bootstrap: the encounter's chosen seeds, while combat rolls afresh.
      const { completionOwnership, encounter } = engineRef.current.getRunConfig();
      engineRef.current.reset(
        startPosition,
        { completionOwnership, encounter: { kind: encounter.kind, seeds: { ...practiceRestart.encounterSeeds } } },
        practiceRestart.runMechanics,
      );
    } else {
      engineRef.current.reset(startPosition, undefined, practiceRestart?.runMechanics);
    }
    // After the reset, so the policy reads the new run's setup (a Retry into wave 69 keeps nothing).
    const started = worn ? carriedRunLoadout(loadout, worn) : loadout;
    const { equipment } = started;
    const inventory = cloneInventory(started.inventory);
    const { supplies } = loadout;
    runLoadoutBaselineRef.current = { equipment: loadout.equipment, inventory: cloneInventory(loadout.inventory) };
    playerEquipmentRef.current = equipment;
    playerInventoryRef.current = inventory;
    playerCombatSuppliesRef.current = supplies;
    engineRef.current.setAttackStylePerCategory(attackStylePerCategory);
    engineRef.current.setInventory(inventory);
    engineRef.current.setEquipment(equipment);
    engineRef.current.setCombatSupplies(supplies);
    engineRef.current.applyPrepotEffects();
    configure?.();
    const resetState = engineRef.current.getState();
    const newPos = resetState.playerPosition;
    replay.startRun(engineRef.current.getRunConfig(), resetState, getReplayUiStateRef.current());
    restartLiveTickSchedule();
    setPlayerConfig((prev) => ({ ...prev, equipment }));
    resetInstantInventoryPreview();
    // Reset drops whatever was still in the latency buffer, so the retire
    // callbacks parked there will never run — clear their previews here or a
    // predicted prayer stays lit on a fight that no longer has it.
    resetPrayerPreview();
    resetInputPresentation();
    setSimulationState(resetState);
    setTargetTile(newPos);
    targetTileRef.current = newPos;
    replay.resetReplay();
    syncLiveAudioHold(liveAudioHoldInputsRef.current, engineRef.current);
  };

  /** Restart the scene's run with its stored loadout; false when the intro forbids it. */
  const resetSceneRun = (options?: {
    readonly configure?: () => void;
    readonly practiceRestart?: EncounterPracticeRestart;
    readonly startPosition?: Coordinate;
    readonly keepWornEquipment?: boolean;
  }): boolean => {
    if (simulationState.introActive && !replay.replayMode) return false;
    const activeEncounter =
      sceneState.kind === 'encounter'
        ? sceneState.encounterKind
        : sceneState.kind === 'loading'
          ? sceneState.targetEncounter
          : 'lobby';
    resetRun(
      {
        equipment: getEncounterEquipment(activeEncounter),
        inventory: getEncounterInventory(activeEncounter),
        supplies: getEncounterSupplies(activeEncounter),
      },
      options?.configure,
      options?.practiceRestart,
      options?.startPosition,
      options?.keepWornEquipment,
    );
    return true;
  };

  /**
   * Restart the fight; a practice restart (Inferno's "Retry Wave") runs with its own run mechanics,
   * which the engine records but never saves, so the next plain restart uses the player's setup.
   * Either opens where the encounter says (the Inferno: where the player stands), else its default,
   * and keeps the gear worn now where the restarted run offers countdown movement.
   */
  const restartFight = (practiceRestart?: EncounterPracticeRestart) => {
    const startPosition = practiceRestart
      ? practiceRestart.startPosition
      : (engineRef.current.planRestartStart() ?? undefined);
    if (
      resetSceneRun({ practiceRestart, startPosition, keepWornEquipment: true }) &&
      sceneState.kind === 'encounter' &&
      !replay.replayMode
    ) {
      setFightStartPresentation('restart');
      startFightStartCountdown('fresh');
    }
  };
  const handleReset = () => restartFight();
  const practiceRestartRef = useRef(restartFight);
  practiceRestartRef.current = restartFight;

  // Tutorial runs are held by their own steps, so neither of these counts down.
  const resetForTutorial = ({ mechanicsConfig, ...loadout }: TutorialRunSetup): void => {
    cancelFightStartCountdown();
    resetRun(loadout, () => {
      engineRef.current.setMechanicsConfig(mechanicsConfig);
      setTutorialPaused(true);
    });
  };
  const handleTutorialReset = (completionOwnership: EncounterCompletionOwnership): void => {
    engineRef.current.setCompletionOwnership(completionOwnership);
    resetSceneRun();
  };

  const handleIntroComplete = useCallback(() => {
    if (replay.replayMode) {
      return;
    }
    const currentEngine = engineRef.current;
    if (!currentEngine.getState().introActive) {
      return;
    }
    currentEngine.completeIntro();
    setSimulationState(currentEngine.getState());
  }, [replay.replayMode]);

  /**
   * Seek the simulation forward to `toTick` in one synchronous batch. Completes
   * the landing intro first (so `canAdvance()` becomes true), then advances
   * tick-by-tick, publishing each tick to the tick bus (so visuals + the demo
   * cursor stay in sync) and recording replay frames. The final
   * `setSimulationState` flips React `introActive` false, which restarts the
   * intro-gated RAF tick loop from `toTick`.
   *
   * Used by tutorial demos to skip the dead lead-up before the first scripted
   * beat. No-op in replay mode. Runs even while graphics are held: the tutorial
   * treats the seek as done, so dropping it would desync the demo script.
   * Guarded at 1000 iterations.
   */
  const fastForwardTicks = useCallback(
    (toTick: number) => {
      if (replay.replayMode) return;
      commitStartPreparation();
      const engine = engineRef.current;
      if (engine.getState().introActive) {
        engine.completeIntro();
      }
      let guard = 0;
      while (
        engine.getState().currentTick < toTick &&
        engine.canAdvance() &&
        !engine.isTutorialPaused() &&
        guard < 1000
      ) {
        const moveTarget = engine.getState().playerPosition;
        engine.advanceTick(moveTarget);
        const newState = engine.getState();
        const tickEvents = engine.getLastTickEvents();
        replay.recordFrame(newState.currentTick, moveTarget, newState, tickEvents, getReplayUiStateRef.current());
        tickBus.publish(newState.currentTick, tickEvents);
        guard += 1;
      }
      // Stepped frames end the running tick's timing; a running loop starts a fresh one from here.
      if (guard > 0) restartLiveTickSchedule();
      publishEngineState(engine.getState());
    },
    [replay.replayMode, replay.recordFrame, publishEngineState, restartLiveTickSchedule, commitStartPreparation],
  );

  const handlePrayerChange = (prayer: PrayerType | null) => {
    if (replay.replayMode) return;
    const action = { type: 'protection', prayer } as const;
    const { predicted, retire: retirePrediction } = predictPrayerAction(action);
    recordPrayerFlickInput(predicted.protection === null ? 'off' : 'on');
    const markBitsSent = flipPrayerBits(clickedPrayerBits('protection', prayer));
    const retirePreview = previewPrayerSlot(
      setProtectionPrayerPreview,
      protectionPrayerPreviewSeqRef,
      predicted.protection,
    );
    dispatchInput(() => {
      replay.recordAction({ type: 'protectionPrayer', prayer });
      engineRef.current.queueProtectionPrayer(prayer);
      retirePrediction();
      markBitsSent();
      retirePreview();
      setSimulationState(engineRef.current.getState());
    });
  };

  const handleOffensivePrayerChange = (prayer: PrayerType | null) => {
    if (replay.replayMode) return;
    const action = { type: 'offensive', prayer } as const;
    const { predicted, retire: retirePrediction } = predictPrayerAction(action);
    recordPrayerFlickInput(predicted.offensive === null ? 'off' : 'on');
    const markBitsSent = flipPrayerBits(clickedPrayerBits('offensive', prayer));
    const retirePreview = previewPrayerSlot(
      setOffensivePrayerPreview,
      offensivePrayerPreviewSeqRef,
      predicted.offensive,
    );
    dispatchInput(() => {
      replay.recordAction({ type: 'offensivePrayer', prayer });
      engineRef.current.queueOffensivePrayer(prayer);
      retirePrediction();
      markBitsSent();
      retirePreview();
      setSimulationState(engineRef.current.getState());
    });
  };

  /**
   * One quick-prayer orb click. The direction is NOT decided here: the engine
   * flips its own quick-prayer flag when the action reaches it, so two clicks
   * inside one tick arrive as two discrete actions and cancel out instead of
   * both reading the same stale render value and repeating one another.
   */
  const handleQuickPrayerToggle = (selectedPrayers: string[]) => {
    if (replay.replayMode) return;
    const selections = selectedPrayers.filter(
      (prayer): prayer is PrayerType => PRAYER_CATEGORIES[prayer] !== undefined,
    );

    // Instant Prayer prediction only, resolved off the engine (never off React
    // state, which can still be a render behind) with the same pure resolver the
    // engine commits with.
    const action = { type: 'quickPrayers', selections } as const;
    const { predicted, retire: retirePrediction } = predictPrayerAction(action);
    // Classified by where the click leaves the prayers, resolved off the engine
    // with the same pure resolver it commits with, so two orb clicks inside one
    // tick read as on then off rather than two ons.
    recordPrayerFlickInput(
      predicted.protection === null && predicted.offensive === null && predicted.independent.length === 0
        ? 'off'
        : 'on',
    );
    // The orb writes no book bits: it flips the quick-prayer flag and redraws the orb
    // alone, so the prayers it assigns reach the book from the server and the book
    // holds committed state until the tick. Instant Prayer predicts both slots below.
    const retireProtection = previewPrayerSlot(
      setProtectionPrayerPreview,
      protectionPrayerPreviewSeqRef,
      predicted.protection,
    );
    const retireOffensive = previewPrayerSlot(
      setOffensivePrayerPreview,
      offensivePrayerPreviewSeqRef,
      predicted.offensive,
    );
    const retireIndependent = previewIndependentPrayers(predicted.independent);

    dispatchInput(() => {
      replay.recordAction({ type: 'quickPrayerToggle', selections });
      engineRef.current.queueQuickPrayerToggle(selections);
      retirePrediction();
      retireProtection();
      retireOffensive();
      retireIndependent();
      setSimulationState(engineRef.current.getState());
    });
  };

  const handleIndependentPrayerChange = (prayer: PrayerType) => {
    if (replay.replayMode) return;
    const action = { type: 'independent', prayer } as const;
    const { predicted, retire: retirePrediction } = predictPrayerAction(action);
    recordPrayerFlickInput(predicted.independent.includes(prayer) ? 'on' : 'off');
    const markBitsSent = flipPrayerBits(clickedPrayerBits('independent', prayer));
    const retirePreview = previewIndependentPrayers(predicted.independent);
    dispatchInput(() => {
      replay.recordAction({ type: 'independentPrayer', prayer });
      engineRef.current.queueIndependentPrayer(prayer);
      retirePrediction();
      markBitsSent();
      retirePreview();
      setSimulationState(engineRef.current.getState());
    });
  };

  const handleUnequipSlot = (slot: string) => {
    if (replay.replayMode) return;
    const typedSlot = slot as keyof PlayerEquipment;
    // Lag the server-side unequip; the instant-inventory preview below stays
    // immediate (client prediction), so it shows the change now and reverts
    // until the queued action lands a tick or more later, as in-game.
    dispatchSpecialAttackInput({ type: 'unequip', slot: typedSlot }, () => {
      replay.recordAction({ type: 'unequip', slot: typedSlot });
      engineRef.current.queueUnequip(typedSlot);
    });
    if (instantInventoryEnabled) {
      const state = engineRef.current.getState();
      const previewBase = instantInventoryPreviewRef.current ?? {
        inventory: state.inventory,
        equipment: state.playerEquipment,
      };
      const preview = engineRef.current.previewUnequipState(previewBase.inventory, previewBase.equipment, typedSlot);
      if (preview) {
        instantInventoryPreviewRef.current = preview;
      }
    }
  };

  const handleUnequipAmmo = () => {
    if (replay.replayMode) return;
    // Lag the server-side unequip; the instant-inventory preview below stays
    // immediate (client prediction), as with the other equipment handlers.
    dispatchSpecialAttackInput({ type: 'unequip_ammo' }, () => {
      replay.recordAction({ type: 'unequipAmmo' });
      engineRef.current.queueUnequipAmmo();
    });
    if (instantInventoryEnabled) {
      const state = engineRef.current.getState();
      const previewBase = instantInventoryPreviewRef.current ?? {
        inventory: state.inventory,
        equipment: state.playerEquipment,
      };
      const preview = engineRef.current.previewUnequipAmmo(
        previewBase.inventory,
        engineRef.current.getCombatSupplies(),
      );
      if (preview) {
        instantInventoryPreviewRef.current = { inventory: preview, equipment: previewBase.equipment };
      }
    }
  };

  const handleEquipmentSlotClick = (slot: string): boolean => {
    if (replay.replayMode) return false;
    const typedSlot = slot as EquipmentClickSlot;
    // Ask the encounter, synchronously, whether this click is meaningful right now. Everything
    // below is the unchanged input path: the action is recorded for replay and dispatched through
    // the engine's normal input lag, and acceptance is deliberately NOT re-checked inside the
    // closure — re-checking after the lag would change behavior.
    if (!engineRef.current.acceptsEncounterInput({ kind: 'equipmentSlotClick', slot: typedSlot })) {
      return false;
    }
    dispatchInput(() => {
      replay.recordAction({ type: 'equipmentSlotClick', slot: typedSlot });
      engineRef.current.queueEquipmentSlotClick(typedSlot);
    });
    return true;
  };

  const handleEquipFromInventory = (inventoryIndex: number) => {
    if (replay.replayMode) return null;
    const currentEngine = engineRef.current;
    const state = currentEngine.getState();
    const previewBase =
      instantInventoryEnabled && instantInventoryPreviewRef.current
        ? instantInventoryPreviewRef.current
        : {
            inventory: state.inventory,
            equipment: state.playerEquipment,
          };
    const item = previewBase.inventory[inventoryIndex];
    if (!item) return null;
    const slot = currentEngine.getItemEquipSlot(item.id);
    if (!slot) {
      // Worn ammo (cache wear position 13) is not a keyof PlayerEquipment; it
      // lives in combat supplies, so it is routed to the dedicated ammo-equip
      // queue and previewed (the stack leaves its inventory slot) client-side.
      if (currentEngine.isAmmoItem(item.id)) {
        dispatchSpecialAttackInput({ type: 'equip_ammo', inventoryIndex, itemId: item.id }, () => {
          replay.recordAction({ type: 'equipAmmoFromInventory', inventoryIndex, itemId: item.id });
          currentEngine.queueEquipAmmoFromInventory(inventoryIndex, item.id);
        });
        if (instantInventoryEnabled) {
          const preview = currentEngine.previewEquipAmmoFromInventory(
            previewBase.inventory,
            currentEngine.getCombatSupplies(),
            inventoryIndex,
          );
          if (preview) {
            instantInventoryPreviewRef.current = { inventory: preview, equipment: previewBase.equipment };
            return preview;
          }
        }
      }
      return null;
    }
    // Lag the server-side equip; the instant-inventory preview below stays
    // immediate (client prediction), so it shows the swap now and reverts until
    // the queued equip lands a tick or more later, as in-game.
    dispatchSpecialAttackInput({ type: 'equip', inventoryIndex, itemId: item.id, slot }, () => {
      replay.recordAction({ type: 'equipFromInventory', inventoryIndex, itemId: item.id, slot });
      currentEngine.queueEquipFromInventory(inventoryIndex, item.id, slot);
    });
    if (instantInventoryEnabled) {
      const preview = currentEngine.previewEquipFromInventoryState(
        previewBase.inventory,
        previewBase.equipment,
        inventoryIndex,
        slot,
      );
      if (preview) {
        instantInventoryPreviewRef.current = preview;
        return preview.inventory;
      }
    }
    return null;
  };

  const handleUseItem = (inventoryIndex: number, option: ItemActionOption = 'default') => {
    if (replay.replayMode) return;
    dispatchSpecialAttackInput({ type: 'use_item', inventoryIndex, option }, () => {
      replay.recordAction({ type: 'itemAction', inventoryIndex, option });
      engineRef.current.queueItemAction(inventoryIndex, option);
      resetInstantInventoryPreview();
    });
  };

  /**
   * OSRS "Drop". Unlike eat/drink/equip this leaves the attack interaction alone —
   * dropping vials mid-fight does not stop the player attacking in game.
   */
  const handleDropItem = (inventoryIndex: number) => {
    if (replay.replayMode) return;
    dispatchSpecialAttackInput({ type: 'drop_item', inventoryIndex }, () => {
      replay.recordAction({ type: 'dropItem', inventoryIndex });
      engineRef.current.queueDropItem(inventoryIndex);
      resetInstantInventoryPreview();
    });
  };

  const handleSwapInventorySlots = (fromIndex: number, toIndex: number) => {
    if (replay.replayMode) return;
    replay.recordAction({ type: 'swapInventory', from: fromIndex, to: toIndex });
    engineRef.current.swapInventorySlots(fromIndex, toIndex);
    resetInstantInventoryPreview();
    setSimulationState(engineRef.current.getState());
  };

  /** One run-orb click. Discrete and engine-resolved, exactly like the quick-prayer orb. */
  const handleRunToggle = () => {
    if (replay.replayMode) return;
    const engineState = engineRef.current.getState();
    const displayedRunEnabled = runPreview.get() ?? engineState.isRunEnabled;
    const retirePreview = runPreview.show(!displayedRunEnabled);
    dispatchInput(() => {
      replay.recordAction({ type: 'runToggle' });
      engineRef.current.queueRunToggle();
      retirePreview();
      setSimulationState(engineRef.current.getState());
    });
  };

  const handleSpecialAttackToggle = () => {
    if (replay.replayMode) return;
    dispatchSpecialAttackInput({ type: 'special_attack_toggle' }, () => {
      replay.recordAction({ type: 'specialAttackToggle' });
      engineRef.current.queueSpecialAttackToggle();
    });
  };

  const handleMarkOfDarknessCast = () => {
    if (replay.replayMode) return;
    dispatchInput(() => {
      replay.recordAction({ type: 'castMarkOfDarkness' });
      engineRef.current.applyAction({ type: 'castMarkOfDarkness' });
      setSimulationState(engineRef.current.getState());
    });
  };

  const handleDeathChargeCast = () => {
    if (replay.replayMode) return;
    dispatchInput(() => {
      replay.recordAction({ type: 'castDeathCharge' });
      engineRef.current.applyAction({ type: 'castDeathCharge' });
      setSimulationState(engineRef.current.getState());
    });
  };

  const handleAttackStyleChange = (index: number) => {
    if (replay.replayMode) return;
    const retirePreview = attackStylePreview.show(index);
    dispatchInput(() => {
      replay.recordAction({ type: 'attackStyleChange', index });
      engineRef.current.setSelectedAttackStyleIndex(index);
      const categoryKey = getWeaponCategoryKey(playerConfig.equipment.weapon);
      updateAttackStylePerCategory({
        ...attackStylePerCategory,
        [categoryKey]: index,
      });
      retirePreview();
      setSimulationState(engineRef.current.getState());
    });
  };

  /**
   * Set the autocast spell from the Combat tab picker. Autocast is a persistent
   * setting rather than a consumable, so it is written back to the encounter's
   * stored loadout — otherwise `handleReset` would restore the previous spell.
   */
  const handleSelectedSpellChange = (spellName: string) => {
    if (replay.replayMode) return;
    const retirePreview = selectedSpellPreview.show(spellName);
    dispatchInput(() => {
      replay.recordAction({ type: 'selectedSpellChange', spellName });
      engineRef.current.setSelectedSpell(spellName);
      const nextSupplies = engineRef.current.getCombatSupplies();
      playerCombatSuppliesRef.current = nextSupplies;
      const activeEncounter =
        sceneState.kind === 'encounter'
          ? sceneState.encounterKind
          : sceneState.kind === 'loading'
            ? sceneState.targetEncounter
            : 'lobby';
      setEncounterSupplies(activeEncounter, nextSupplies);
      retirePreview();
      setSimulationState(engineRef.current.getState());
    });
  };

  // Lands on the next tick, where the replay's `applyAction` also lands it (see
  // `SimulationEngine.queueEncounterCommand`), so nothing changes in the state until then.
  // The practice controls' commands are memoized: the Mobile tool window keeps its Practice pane
  // mounted while hidden and skips re-rendering it only while these keep their identity.
  const handleExecuteEncounterCommand = useCallback(
    (command: EncounterCommand): boolean => {
      if (replay.replayMode) return false;
      const restart = engineRef.current.planPracticeRestart(command);
      if (restart) {
        practiceRestartRef.current(restart);
        return true;
      }
      if (!engineRef.current.queueEncounterCommand(command)) return false;
      replay.recordAction({ type: 'encounterCommand', command });
      return true;
    },
    [replay.replayMode, replay.recordAction],
  );
  const encounterSession = replay.replayMode
    ? null
    : encounterPracticeSession(simulationState.encounter, handleExecuteEncounterCommand);
  /**
   * Ctrl+R without a replay practice start (`useReplay` calls it as `onRetryFight`, after its own
   * holds): the encounter session's primary where the run has one (Inferno's Retry wave), exactly as
   * its bar runs it, else the whole fight. The outcome dialogs' primary button takes the same
   * precedence (`OutcomePracticeActions`).
   */
  const retryShortcut = () => {
    if (encounterSession) encounterSession.primary.onClick();
    else handleReset();
  };

  const handleSetBossHp = useCallback(
    (hp: number) => {
      if (replay.replayMode) return;
      replay.recordAction({ type: 'setBossHp', hp });
      engineRef.current.applyAction({ type: 'setBossHp', hp });
      setSimulationState(engineRef.current.getState());
    },
    [replay.replayMode, replay.recordAction],
  );

  const handleApplyBossHpPreset = useCallback(
    (hp: number) => {
      if (replay.replayMode) return;
      replay.recordAction({ type: 'applyBossHpPreset', hp });
      engineRef.current.applyAction({ type: 'applyBossHpPreset', hp });
      setSimulationState(engineRef.current.getState());
    },
    [replay.replayMode, replay.recordAction],
  );

  // Simulation-owned, so the orb reflects the engine's quick-prayer flag rather
  // than recomputing a toggle from React state that a same-tick second click
  // could read stale. While an input is still crossing the lag buffer, render
  // the same ordered prediction used by the prayer-book slots.
  const quickPrayersActive = replay.replayMode
    ? replay.displayState.quickPrayersActive
    : (predictedPrayerInputRef.current?.quickPrayersActive ?? simulationState.quickPrayersActive);

  const projectedSpecialAttackActive =
    !replay.replayMode && sentSpecialAttackOps.length > 0
      ? engineRef.current.projectSpecialAttackState(sentSpecialAttackOps)
      : undefined;
  // The committed destination comes from the ref, which every site sets together with the preview's
  // retirement, so no frame falls back to a stale prop while the state commits.
  const getStartPositionPreparation = useCallback(() => startPositionPreparationRef.current, []);
  const getDisplayedTargetTile = useCallback((): Coordinate | null => {
    const preview = targetTilePreview.get();
    return preview !== undefined ? preview : targetTileRef.current;
  }, [targetTilePreview.get]);
  const inputPresentation = useMemo<InputPresentation>(
    () => ({
      runEnabled: runPreview.value,
      specialAttackActive: projectedSpecialAttackActive,
      selectedAttackStyleIndex: attackStylePreview.value,
      selectedSpell: selectedSpellPreview.value,
      getTargetTile: getDisplayedTargetTile,
      getStartPositionPreparation,
    }),
    [
      attackStylePreview.value,
      runPreview.value,
      selectedSpellPreview.value,
      projectedSpecialAttackActive,
      getDisplayedTargetTile,
      getStartPositionPreparation,
    ],
  );

  return {
    focusPaused,
    engine,
    engineRef,
    dispatchInput,
    handleAttackStyleChange,
    handleSelectedSpellChange,
    handleEquipFromInventory,
    handleEquipmentSlotClick,
    handleIntroComplete,
    fightStartCountdown: fightStartCountdown.descriptor,
    fightStartCountdownActive: fightStartCountdown.active,
    fightStartCountdownPhase: fightStartCountdown.holding ? 'holding' : fightStartCountdown.active ? 'released' : null,
    fightStartPresentation,
    handleFightStartCountdownFinished: fightStartCountdown.finish,
    fastForwardTicks,
    setTutorialPaused,
    handleMarkOfDarknessCast,
    handleDeathChargeCast,
    handleIndependentPrayerChange,
    handleOffensivePrayerChange,
    handlePrayerChange,
    handleQuickPrayerToggle,
    handleReset,
    resetForTutorial,
    handleTutorialReset,
    handleRunToggle,
    handleSceneReady,
    handleSpecialAttackToggle,
    handleSwapInventorySlots,
    handleExecuteEncounterCommand,
    encounterSession,
    handleSetBossHp,
    handleApplyBossHpPreset,
    handleUnequipSlot,
    handleUnequipAmmo,
    handleUseItem,
    handleDropItem,
    isSceneReady,
    playerEquipmentRef,
    playerInventoryRef,
    playerCombatSuppliesRef,
    replay,
    replayPlayerConfig,
    instantInventoryResetToken,
    inputPresentation,
    previewTargetTile: targetTilePreview.show,
    prayerPresentation,
    quickPrayersActive,
    setEngine,
    setIsSceneReady,
    publishEngineState,
    setSimulationState,
    setTargetTile,
    simulationState,
    targetTile,
    targetTileRef,
    tickTimingRef,
  };
}
