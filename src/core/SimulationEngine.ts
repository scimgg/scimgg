import {
  EMPTY_VIAL_ID,
  getAttackDelayForTrack,
  getItemAction,
  getPrepotEffects,
  ITEM_ACTIONS,
  type ItemActionDef,
  type ItemActionOption,
  isPrepottable,
} from '../data/itemEffects';
import { applyMonsterStatOverrideToFormulaStats } from '../data/monsterData';
import { hasPrayerRestorationEnhancement } from '../data/prayerRestoration';
import { DEATH_CHARGE_SPELL, MARK_OF_DARKNESS_SPELL } from '../data/spellRunes';
import { gracefulRegenBonusPercent } from '../data/weightReducingClothing';
import { baseEncounterKind } from '../encounters/catalog';
import type { ObjTypeLoader } from '../rs/config/objtype/ObjTypeLoader';
import { SpotAnimID } from '../rs/config/spotanimtype/SpotAnimID';
import type { PlayerEquipment } from '../rs/model/PlayerModelLoader';
import { packHsl } from '../rs/util/ColorUtil';
import {
  getDefaultAttackStyleIndex,
  getWeaponCategory,
  getWeaponCategoryKey,
  resolveActiveSpell,
} from '../types/attackStyles';
import type { CombatSupplies } from '../types/encounterLoadout';
import { cloneCombatSupplies, createEmptyCombatSupplies } from '../types/encounterLoadout';
import type { EquipmentStats } from '../types/equipmentStats';
import {
  computeTotalEquipmentStats,
  computeTotalWeight,
  createEmptyStats as createEmptyEquipmentStats,
  loadItemStats,
} from '../types/equipmentStats';
import type { GroundItem } from '../types/groundItems';
import type { Inventory } from '../types/inventory';
import { addItemToInventory, createEmptyInventory, isStackableItem, removeInventorySlot } from '../types/inventory';
import type { MonsterStatOverride } from '../types/monsterStatOverride';
import type {
  CombatTimers,
  CooldownTrackState,
  EffectTimer,
  PlayerStats,
  RunEnergyState,
  SpecialAttackState,
} from '../types/playerState';
import {
  cloneBaseStats,
  createDefaultPoisonState,
  createDefaultRunEnergy,
  createDefaultSpecialAttack,
  createDefaultStats,
  createDefaultTimers,
  LIGHTBEARER_ITEM_ID,
  POISON_TICK_INTERVAL,
  PURGING_STAFF_ITEM_ID,
  RESTORABLE_STATS,
  RING_OF_ENDURANCE_ITEM_ID,
  RUN_ENERGY_MAX,
} from '../types/playerState';
import type {
  Coordinate,
  DamageHistoryEntry,
  MechanicsConfig,
  NpcAttackTimer,
  PrayerState,
  SimulationEvent,
  SimulationState,
  TickNumber,
} from '../types/simulation';
import {
  createDefaultPrayerState,
  EventType,
  type FailCondition,
  isPrayerUnlocked,
  mergeMechanicsConfig,
  PRAYER_CATEGORIES,
  PrayerType,
  REDEMPTION_HEAL_FRACTION,
} from '../types/simulation';
import { log } from '../util/Logger';
import type { ActorBase } from './actors/ActorBase';
import type { NpcActor } from './actors/NpcActor';
import type { PlayerActor } from './actors/PlayerActor';
import type { ActorId, DamageType, QueuedDropAction, QueuedEquipmentAction, QueuedItemAction } from './actors/types';
import { resolveAttackResources } from './combat/attackResources';
import { type CombatBridge, CombatSystem, type DamageAppliedInfo, type PrayerReduction } from './combat/CombatSystem';
import {
  calculatePrayerDamage,
  type DamageValue,
  didPrayCorrectly as didPrayCorrectlyShared,
  resolveDamage,
} from './combat/damageCalculation';
import { chebyshevDistanceToRect, isInAttackRange, isUnderNpc } from './combat/distance';
import { advanceNpcHitpointRegen } from './combat/npcRegeneration';
import { isConflictionAttackEligible } from './combat/player/confliction';
import {
  type FirstPartyPlayerAttackProjectionSummary,
  projectFirstPartyPlayerAttack,
} from './combat/player/firstPartyPlayerAttack';
import { processPlayerAutoAttack, resolvePlayerAttackParams } from './combat/player/PlayerAutoAttackSystem';
import {
  cancelBlockedPlayerAttack,
  canPlayerStartAttackOn,
  clearPlayerAttackIntent,
  registerPlayerAttackIntent,
} from './combat/player/playerAttackIntent';
import { tickSoulreaperDecay } from './combat/player/soulreaper';
import {
  activateInstantSpecial,
  endPowerOfDeathOnDamage,
  powerOfDeathMeleeMultiplier,
  resolveInstantSpecialActivation,
} from './combat/player/specialAttacks/instantSpecial';
import { hasSpecialAttack } from './combat/player/specialAttacks/registry';
import type { OnKillEffect } from './combat/player/specialAttacks/types';
import { processNpcRetaliations } from './combat/retaliation';
import { canCastSpell } from './combat/runeAvailability';
import {
  formulaStyleToAttackKind,
  formulaStyleToDamageType,
  getFormulaStyle,
  getPlayerEffectiveCombatParams,
} from './combat/weaponCombatData';
import {
  ACTOR_HISTORY_WINDOW_TICKS,
  DEAD_ACTOR_PRUNE_GRACE_TICKS,
  getResolvedArenaConfig,
  SIMULATION_START_TICK,
  setArenaConfig,
} from './constants';
import { isValidArenaCoordinate } from './coordinates';
import { type DecisionRandom, generatorDecisionRandom } from './decisionRandom';
import type { EncounterCommand } from './encounters/commands';
import type { EncounterOutcome } from './encounters/outcome';
import type { EncounterSnapshot } from './encounters/snapshot';
import type {
  Encounter,
  EncounterCompletionOwnership,
  EncounterContext,
  EncounterEngineContext,
  EncounterEngineRules,
  EncounterInput,
  EncounterInputState,
  EncounterIntroConfig,
  EncounterNpcDefeat,
  EncounterPlayerDamageInfo,
  EncounterPlayerLockContext,
  EncounterPracticeRestart,
  EncounterPrayerDrainParams,
  EncounterRestartContext,
  EncounterRunStartContext,
  EnvironmentalDamage,
  EquipmentClickSlot,
  HookResult,
  NpcAttackRequest,
  NpcMovementInfo,
  NpcMovementRequest,
} from './encounters/types';
import { resolveDynamic } from './encounters/types';
import {
  ENGINE_RUN_BOOTSTRAP_VERSION,
  type EngineRunBootstrap,
  type EngineRunConfig,
  resolveRunBootstrap,
} from './engineRunConfig';
import { type EmittableGameEvent, TickEvents } from './events/TickEvents';
import type { EquipSoundKind, GameEvent, OverheadTextSegment } from './events/types';
import {
  buildPendingPrayerProjection,
  type PendingInputOp,
  type PrayerRestoreProjectionRules,
  projectPendingPrayerInput,
} from './inputOps';
import type { ItemActionState } from './itemActions';
import { applyCooldown, applyEffects, canUseAction, consumeItem, isItemActionRefused } from './itemActions';
import { type MovementResult, playerMoveAutopath, playerMoveToNpc } from './movement';
import { isNpcMovementSuppressed } from './npcCombatMovement';
import {
  canNpcActThisTurn,
  isCurrentActorInstance,
  isNpcDeathAnimationDue,
  isNpcDeathDue,
  isNpcDeathReleaseDue,
  pruneGraceStartTick,
  recordNpcLethalTransition,
  recordNpcStep,
  reviveNpc,
  startNpcDeath,
} from './npcDeath';
import { npcFootprintsOverlap } from './npcOccupancy';
import { NpcDefinitionCollection, type NpcDefinitionContext } from './npcs';
import {
  type PrayerInputOutcome,
  prayerSetLogChanges,
  type QueuedPrayerAction,
  resolvePrayerActions,
} from './prayerInput';
import type { ReplayTakeoverWork } from './replayTakeover';
import { mulberry32 } from './rng';
import {
  drainStat,
  expireStatDecayLocks,
  hpRegenInterval,
  tickNaturalHitpoints,
  tickNaturalStatChange,
  withStatCurrent,
} from './statLevels';
import {
  castDeathCharge as castDeathChargeTimer,
  castMarkOfDarkness as castMarkOfDarknessTimer,
  consumeDeathCharge,
  isPreserveQualified,
  isRapidRestoreDue,
  refillSpecialAttack,
  syncLightbearer,
  tickCombatTimers,
  tickPoisonState,
  tickPrayerDrain,
  tickRunEnergy,
  tickSpecialAttack,
} from './timers';
import { toSimulationState, WorldState } from './WorldState';

export type { EngineRunBootstrap, EngineRunConfig } from './engineRunConfig';
export { ENGINE_RUN_BOOTSTRAP_VERSION } from './engineRunConfig';

function normalizeCombatSeed(seed: number | undefined): number {
  return Number.isInteger(seed) && (seed as number) >= 0 ? (seed as number) : Math.floor(Math.random() * 0xffffffff);
}

/** Order-sensitive, since the player's prayer sets are insertion-ordered state. */
function samePrayers(a: readonly PrayerType[], b: readonly PrayerType[]): boolean {
  return a.length === b.length && a.every((prayer, index) => prayer === b[index]);
}

/**
 * `human_cast_selfimbue` — the shared Arceuus self-buff cast, which Mark of Darkness plays too.
 *
 * NOT `AnimationID.DEATH_CHARGE` (8983): that id names the spell but animates its EFFECT, and
 * playing it on the caster renders as a garbled pose. The capture settles it —
 * `yama-contract-of-sensory-clouding-packet-data-1` t8905 emits `sequence id=human_cast_selfimbue
 * (8970)` beside the cast spotanim.
 */
export const SELF_IMBUE_CAST_ANIM_ID = 8970;

/** The flash played on the player when Redemption procs. */
export const REDEMPTION_SPOTANIM_ID = SpotAnimID.VFX_PLAYER_REDEMPTION;
// SpotanimID.DEATH_CHARGE_CAST_SPOTANIM / DEATH_CHARGE_UPGRADE_CAST_SPOTANIM. The upgraded id is
// the one the capture plays at t8905, alongside "your next two foes".
const DEATH_CHARGE_SPOTANIM_ID = SpotAnimID.VFX_PLAYER_DEATH_CHARGE;
const DEATH_CHARGE_UPGRADE_SPOTANIM_ID = SpotAnimID.VFX_PLAYER_DEATH_CHARGE_UPGRADE;
/** SpotanimID.MARK_OF_DARKNESS_CAST_SPOTANIM. */
const MARK_OF_DARKNESS_SPOTANIM_ID = 1852;

const WEAR_POS_TO_SLOT: Record<number, keyof PlayerEquipment> = {
  0: 'head',
  1: 'cape',
  2: 'amulet',
  3: 'weapon',
  4: 'body',
  5: 'shield',
  7: 'legs',
  9: 'hands',
  10: 'boots',
  12: 'ring',
};

/**
 * OSRS cache wear position for the ammunition/quiver slot. Ammo is equippable
 * (wearPos1 === 13) but is NOT a `keyof PlayerEquipment`; it lives in
 * `combatSupplies.equippedAmmo`, so it is intentionally absent from
 * WEAR_POS_TO_SLOT and routed separately.
 */
const AMMO_WEAR_POSITION = 13;

const PLAYER_ACTOR_ID = 'player';

const PRAYER_LOCKOUT_MESSAGE: readonly OverheadTextSegment[] = [
  { text: "You've been injured and can't use that prayer!" },
];

interface PendingNpcDefeat {
  readonly actor: NpcActor;
  readonly defeat: EncounterNpcDefeat;
}

const METAL_BODY_NAME_FRAGMENTS = [
  'platebody',
  'chainbody',
  'hauberk',
  'cuirass',
  'chestplate',
  'platemail',
  'armour',
  'armor',
];

const NON_METAL_BODY_NAME_FRAGMENTS = [
  'robe',
  'robetop',
  'tunic',
  'shirt',
  'jacket',
  'vest',
  'leather',
  'hide',
  "d'hide",
];

const VENOM_THRESHOLD = 1_000_000;

export interface SimulationEngineOptions {
  replayTakeoverWork?: ReplayTakeoverWork;
  startPos?: Coordinate;
  initialInventory?: Inventory;
  objTypeLoader?: ObjTypeLoader | null;
  encounter?: Encounter;
  enableIntro?: boolean;
  stats?: PlayerStats;
  /**
   * Current hitpoints the player starts the encounter on, for variants that declare
   * `EncounterVariant.startingHitpoints`. Leaves max HP alone — the player keeps the
   * hitpoints level they configured, and only the bar they open the fight with moves.
   */
  startHp?: number;
  /**
   * The config `encounterRegistry.create` was called with (invocations). Held only so
   * `getRunConfig()` can hand it to a reconstruction; the encounter has already consumed it.
   */
  encounterConfig?: Record<string, unknown>;
  /**
   * Seeds {@link SimulationEngine.rollCombat}. Omitted for a fresh run (one is rolled and
   * recorded); supplied when reconstructing a recorded run, which is the whole point of it.
   */
  combatSeed?: number;
  /**
   * Replaces the seeded stream outright. Use it to force a specific roll (a guaranteed proc);
   * use {@link SimulationEngineOptions.combatSeed} when you want a real, reproducible fight.
   * Survives `reset`, so a run rebuilt from a run config keeps the injected stream.
   */
  combatRandom?: () => number;
  /**
   * Labels the decisions NPC definitions draw from the combat stream in engine-owned contexts
   * (death-animation releases, damage reactions). Default: plain draws, so seeded runs are unchanged.
   * Capture replays substitute constrained decisions over the same stream.
   */
  combatDecisions?: (next: () => number) => DecisionRandom;
  /**
   * The player's mechanics, applied before the world is built so the encounter opens the
   * configured run setup (a start wave) rather than its default. Same as a later
   * `setMechanicsConfig`, which a caller may still make.
   */
  mechanics?: Partial<MechanicsConfig>;
}

export type EngineAction =
  | { type: 'protectionPrayer'; prayer: PrayerType | null }
  // A click on any boost prayer (see `PRAYER_CATEGORIES`). Recordings made when the boost set was a
  // single offensive slot carry this same action, so its name and its null (turn every boost
  // prayer off) stay as recorded.
  | { type: 'offensivePrayer'; prayer: PrayerType | null }
  | { type: 'independentPrayer'; prayer: PrayerType }
  | { type: 'equipFromInventory'; inventoryIndex: number; itemId: number; slot: keyof PlayerEquipment }
  | { type: 'equipAmmoFromInventory'; inventoryIndex: number; itemId: number }
  | { type: 'unequipAmmo' }
  | { type: 'itemAction'; inventoryIndex: number; option?: ItemActionOption }
  | { type: 'unequip'; slot: keyof PlayerEquipment }
  | { type: 'specialAttackToggle' }
  | { type: 'runToggle' }
  | { type: 'quickPrayerToggle'; selections: PrayerType[] }
  | { type: 'castMarkOfDarkness' }
  | { type: 'castDeathCharge' }
  | { type: 'ctrlClick'; ctrlKey: boolean }
  | { type: 'swapInventory'; from: number; to: number }
  | { type: 'attackTarget'; targetId: ActorId | null }
  | { type: 'manualCast'; spellName: string; targetId: ActorId }
  | { type: 'npcInteraction'; targetId: ActorId }
  | { type: 'equipmentSlotClick'; slot: EquipmentClickSlot }
  | { type: 'attackStyleChange'; index: number }
  | { type: 'selectedSpellChange'; spellName: string }
  | { type: 'setBossHp'; hp: number }
  | { type: 'applyBossHpPreset'; hp: number }
  | { type: 'dropItem'; inventoryIndex: number }
  | { type: 'pickupGroundItem'; groundItemId: string }
  /**
   * Mutates the engine outside the tick loop, so a reconstruction that does not replay it lands
   * on a different fight than the recording.
   */
  | { type: 'encounterCommand'; command: EncounterCommand };

export interface InventoryEquipmentPreview {
  inventory: Inventory;
  equipment: PlayerEquipment;
}

/** One countdown positioning step, for presentation; see `SimulationEngine.prepareStartPosition`. */
export interface StartPositionStep {
  readonly from: Coordinate;
  readonly stepTiles: readonly Coordinate[];
  readonly to: Coordinate;
  readonly isRunning: boolean;
}

interface EquipmentInputState {
  readonly inventory: Inventory;
  readonly equipment: PlayerEquipment;
  readonly combatSupplies: CombatSupplies;
}

export class SimulationEngine {
  private replayTakeoverWork: ReplayTakeoverWork | undefined;
  private worldState: WorldState;
  private failedCondition: FailCondition | null;
  private encounter: Encounter;
  /** Effective mechanics: encounter defaults, then the player's, then this run's override. */
  private mechanicsConfig: MechanicsConfig;
  private playerMechanicsConfig: Partial<MechanicsConfig> = {};
  /**
   * Mechanics this run alone uses (a practice restart's start wave, a reconstructed run's recorded
   * setup): never the player's setting, so they reach the recording through `mechanicsConfig` but not
   * the next plain reset.
   */
  private runMechanicsOverride: Readonly<Partial<MechanicsConfig>> = {};
  private damageHistory: DamageHistoryEntry[];
  private eventLog: SimulationEvent[];
  private objTypeLoader: ObjTypeLoader | null;
  private tickEvents: TickEvents;
  private combatSystem: CombatSystem;
  private npcDefinitions: NpcDefinitionCollection;
  private encounterRules: EncounterEngineRules | undefined;
  private protectionPrayerActivatedTick: number | null = null;
  /** Protection prayers refuse activation before this tick; set by a disabling hit. */
  private protectionPrayersDisabledUntilTick = Number.NEGATIVE_INFINITY;
  private lastTickEvents: GameEvent[] = [];
  /** The remaining input may still change the prayer this check is judged against. */
  private selfDamageHitPending = false;
  /** True while NPC turns run: an NPC registered then takes its first turn this tick. */
  private npcTurnsRunning = false;
  /** The tick each NPC registered outside NPC turns was added; it first moves and acts the next tick. */
  private readonly addedOutsideNpcTurns = new WeakMap<NpcActor, number>();
  private _attackStylePerCategory: Record<string, number> = {};
  private _introActive = false;
  private _introEnabled = false;
  /** The intro the reset started this run with, playing or played (none when intros are off or its setup has none). */
  private startedIntro: EncounterIntroConfig | null = null;
  /**
   * The intro the run opens with as its setup stands: `startedIntro`, unless a tick-zero setup edit
   * has moved the run to a setup without it (`setMechanicsConfig`). Drives the landing message and
   * the opening facing.
   */
  private openingIntro: EncounterIntroConfig | null = null;
  private _tutorialPaused = false;
  private pendingEquipmentSlotClicks: EquipmentClickSlot[] = [];
  /**
   * The first tick that accepts player input again ({@link EncounterContext.lockPlayerActionsUntil}):
   * every tick before it drops the player's inputs and walk.
   */
  private playerActionsUnlockTick = Number.NEGATIVE_INFINITY;
  /**
   * Whether this tick discarded the walk target it was given (an action lock or a teleport). Cleared
   * at the start of every advanced tick; see {@link didLastTickDiscardWalkTarget}.
   */
  private walkTargetDiscarded = false;
  /** Run at the start of the next tick; see {@link queueEncounterCommand}. */
  private pendingEncounterCommands: EncounterCommand[] = [];
  private completionOwnership: EncounterCompletionOwnership = 'encounter-owned';
  private pendingNpcDefeats: PendingNpcDefeat[] = [];
  private configuredStats: PlayerStats;
  private startHp: number | undefined;
  private readonly encounterConfig: Record<string, unknown> | undefined;
  /** The tile the player was actually placed on. Encounters randomize it, so it is not re-derivable. */
  private runStartPosition: Coordinate;
  /**
   * Whether the run start invoked {@link applyPrepotEffects}. Recorded so a reconstruction
   * mirrors what the live path actually did instead of assuming it: Auto-Prepot casts spell
   * buffs, so applying it where the recording did not (or skipping it where it did) diverges
   * on tick one and aborts the takeover.
   */
  private prepotApplied = false;
  private combatSeed: number;
  private combatRandom: () => number;
  private readonly combatRandomOverride: (() => number) | undefined;
  /**
   * Every combat consumer captures this ONCE at construction, but `reset()` re-seeds the run.
   * Collapsing the indirection to expose `combatRandom` directly freezes them on the original
   * stream, and a reconstruction then rolls a different fight while looking correct.
   */
  public readonly rollCombat = (): number => this.combatRandom();
  /** Decisions over {@link rollCombat}; see {@link SimulationEngineOptions.combatDecisions}. */
  private readonly combatDecisions: DecisionRandom;

  constructor(options?: SimulationEngineOptions);
  constructor(
    startPos?: Coordinate,
    initialInventory?: Inventory,
    objTypeLoader?: ObjTypeLoader | null,
    encounter?: Encounter,
  );
  constructor(
    optionsOrStartPos?: SimulationEngineOptions | Coordinate,
    initialInventory?: Inventory,
    objTypeLoader?: ObjTypeLoader | null,
    encounter?: Encounter,
  ) {
    const options: SimulationEngineOptions = Array.isArray(optionsOrStartPos)
      ? {
          startPos: optionsOrStartPos,
          initialInventory,
          objTypeLoader,
          encounter,
        }
      : {
          initialInventory,
          objTypeLoader,
          encounter,
          ...(optionsOrStartPos ?? {}),
        };

    this.replayTakeoverWork = options.replayTakeoverWork;
    this.worldState = new WorldState();
    this.failedCondition = null;
    this._introEnabled = options.enableIntro ?? false;
    if (!options.encounter) {
      throw new Error('SimulationEngine requires an explicit encounter');
    }
    this.encounter = options.encounter;
    this.npcDefinitions = this.encounter.getNpcDefinitions?.() ?? new NpcDefinitionCollection();
    this.encounterRules = this.encounter.getEngineRules?.();
    this.playerMechanicsConfig = { ...(options.mechanics ?? {}) };
    this.mechanicsConfig = mergeMechanicsConfig(this.getEncounterDefaultMechanicsConfig(), this.playerMechanicsConfig);
    this.damageHistory = [];
    this.eventLog = [];
    this.objTypeLoader = options.objTypeLoader ?? null;
    this.tickEvents = new TickEvents();
    this.combatRandomOverride = options.combatRandom;
    this.combatSeed = normalizeCombatSeed(options.combatSeed);
    this.combatRandom = this.combatRandomOverride ?? mulberry32(this.combatSeed);
    this.combatDecisions = (options.combatDecisions ?? generatorDecisionRandom)(this.rollCombat);
    this.combatSystem = new CombatSystem({ random: this.rollCombat });
    this.encounterConfig = options.encounterConfig;
    this.configuredStats = cloneBaseStats(options.stats ?? createDefaultStats());
    // Both clamps below pass NaN straight through into the player's hitpoints, so a
    // non-finite option is rejected here rather than at each use.
    this.startHp = Number.isFinite(options.startHp) ? options.startHp : undefined;

    this.applyEncounterArenaConfig(this.encounter);

    const playerStart = options.startPos ?? this.getEncounterDefaultPlayerStart(this.encounter);
    this.runStartPosition = [...playerStart] as Coordinate;
    this.initializeWorld(playerStart, options.initialInventory ?? createEmptyInventory());
  }

  private getEncounterRules(): EncounterEngineRules | undefined {
    return this.encounterRules;
  }

  private buildEngineContext(): EncounterEngineContext {
    return {
      tick: this.worldState.tick,
      player: this.player() as Readonly<PlayerActor>,
      world: this.worldState as Readonly<WorldState>,
    };
  }

  private buildPlayerLockContext(): EncounterPlayerLockContext {
    return {
      ...this.buildEngineContext(),
      lockPlayerActionsUntil: (unlockTick: number): void => this.lockPlayerActionsUntil(unlockTick),
    };
  }

  private buildEncounterCtx(
    tick: number,
    playerPos: Coordinate,
    inputs: EncounterInputState,
    npcMovements: ReadonlyMap<string, NpcMovementInfo>,
    setProtectionPrayer: (prayer: PrayerType | null) => void,
  ): EncounterContext {
    return {
      tick,
      playerPos,
      world: this.worldState,
      tickEvents: this.tickEvents,
      logEvent: (event: SimulationEvent): void => this.logEvent(event),
      grantNextAttackSpeedup: (actorId: string, ticks: number): void =>
        this.combatSystem.speedUpNextAttack(actorId, ticks, tick),
      spawnNpc: (actor: NpcActor): void => this.spawnEncounterNpc(actor),
      despawnNpc: (npcId: ActorId): void => this.despawnEncounterNpc(npcId),
      queueNpcHit: (attack) => this.queueNpcHit(attack),
      rollCombat: this.rollCombat,
      inputs,
      npcMovements,
      setProtectionPrayer,
      disableProtectionPrayersUntil: (untilTick: number): void => this.disableProtectionPrayersUntil(untilTick),
      teleportPlayer: (position: Coordinate, facing: number): void => this.teleportPlayer(position, facing),
      lockPlayerActionsUntil: (unlockTick: number): void => this.lockPlayerActionsUntil(unlockTick),
    };
  }

  /** See {@link EncounterContext.teleportPlayer}. */
  private teleportPlayer(position: Coordinate, facing: number): void {
    const player = this.player();
    this.endPlayerInteraction();
    player.position = [...position] as Coordinate;
    player.previousPosition = player.position;
    player.movementPath = [];
    player.isMoving = false;
    player.isRunning = false;
    player.facing = facing;
    // The player's turn reconciles collision flags before it steps; until then NPCs see the new tile.
    this.worldState.occupancy.reconcile(this.worldState.actors.values());
  }

  /** See {@link EncounterContext.lockPlayerActionsUntil}. */
  private lockPlayerActionsUntil(unlockTick: number): void {
    if (!Number.isSafeInteger(unlockTick)) {
      throw new RangeError(`lockPlayerActionsUntil needs a safe integer tick, got ${unlockTick}`);
    }
    if (unlockTick <= this.worldState.tick) return;
    this.playerActionsUnlockTick = Math.max(this.playerActionsUnlockTick, unlockTick);
    this.endPlayerInteraction();
  }

  /**
   * Ends the player's interaction and queued walk, shared by a teleport and an action lock. The walk
   * target is owned by the caller, so the walk ends by discarding it: no step toward it this tick
   * (unless the player already took it), and the caller drops it before the next.
   */
  private endPlayerInteraction(): void {
    const player = this.player();
    clearPlayerAttackIntent(player);
    player.pendingItemPickup = null;
    player.pendingNpcInteraction = undefined;
    this.walkTargetDiscarded = true;
  }

  /**
   * Whether the tick just advanced discarded the walk target it was given: the player's actions were
   * locked ({@link EncounterContext.lockPlayerActionsUntil}), as the game drops clicks made while the
   * player is delayed, or the player was teleported ({@link EncounterContext.teleportPlayer}), which
   * ends the queued walk. Every caller that carries a walk target into the next tick (the live loop,
   * a manual step, the tutorial fast-forward, a replay takeover's resume target) clears it when this
   * is true, so any further state that drops the walk belongs here. A reconstructed engine answers for its last
   * re-simulated tick, so takeover reads it straight off the rebuilt engine.
   */
  public didLastTickDiscardWalkTarget(): boolean {
    return this.walkTargetDiscarded;
  }

  private buildNpcDefinitionContext(): NpcDefinitionContext {
    return {
      tick: this.worldState.tick,
      world: this.worldState,
      tickEvents: this.tickEvents,
      random: this.rollCombat,
      decisions: this.combatDecisions,
      spawnNpc: (actor) => this.spawnEncounterNpc(actor),
      despawnNpc: (npcId) => this.despawnEncounterNpc(npcId),
      queueNpcHit: (attack) => this.queueNpcHit(attack),
      logEvent: (event) => this.logEvent(event),
      setProtectionPrayer: (prayer) => this.forceSetProtectionPrayer(prayer),
      disableProtectionPrayersUntil: (untilTick) => this.disableProtectionPrayersUntil(untilTick),
    };
  }

  /** Refuses protection-prayer activation before `untilTick`; an existing longer lockout wins. */
  private disableProtectionPrayersUntil(untilTick: number): void {
    this.protectionPrayersDisabledUntilTick = Math.max(this.protectionPrayersDisabledUntilTick, untilTick);
  }

  /**
   * Engine-owned dynamic NPC registration. See {@link EncounterContext.spawnNpc}.
   *
   * Seeding history here matters: an NPC spawned outside an NPC turn (an encounter's band hooks,
   * `processPostTick`, a command) would otherwise have no entry for the tick it appeared on, and
   * anything reading its position history that tick (interpolation, replay) would miss it.
   */
  private spawnEncounterNpc(actor: NpcActor): void {
    if (this.worldState.actors.has(actor.id)) {
      throw new Error(`spawnNpc: duplicate actor id '${actor.id}'`);
    }
    this.replayTakeoverWork?.admitNpcs(this.getNpcCount(), 1);
    this.npcDefinitions.validateActor(actor);
    this.applyEncounterMonsterStatOverride(actor);
    delete actor.crawlMovement;
    this.worldState.registerNpc(actor);
    if (!this.npcTurnsRunning) this.addedOutsideNpcTurns.set(actor, this.worldState.tick);
    actor.history.set(this.worldState.tick, [...actor.position] as Coordinate);
  }

  /**
   * Fold the encounter's restat into the actor's own formula stats at registration, so the
   * ACTOR and the DPS projection answer from one baseline. Doing it here rather than at each
   * read is what stops a percentage defence drain being computed off the dataset and then
   * subtracted from an overridden level.
   */
  private applyEncounterMonsterStatOverride(npc: NpcActor): void {
    npc.formulaStats = applyMonsterStatOverrideToFormulaStats(
      npc.formulaStats,
      this.getMonsterStatOverride(npc.npcTypeId),
    );
  }

  /** Engine-owned vanish (OSRS `del`). See {@link EncounterContext.despawnNpc}. */
  private despawnEncounterNpc(npcId: ActorId): void {
    const npc = this.worldState.getNpc(npcId);
    if (!npc) return;
    this.worldState.removeActor(npcId);
    this.tickEvents.emit({ type: 'actor_despawned', actorId: npcId });
    this.npcDefinitions.notifyDespawn(npc, this.buildNpcDefinitionContext());
  }

  /**
   * Supports both plain string returns (FailCondition) and structured EncounterHookEffect.
   */
  private processHookResult(result: HookResult): FailCondition | null {
    if (result === null || result === undefined) return null;
    if (typeof result === 'string') {
      // Plain string fail condition — suppress stamina failures when infinite stamina is on.
      if (this.mechanicsConfig.infiniteStamina && result === 'StaminaDepleted') return null;
      return result;
    }

    if (result.runEnergyDelta !== undefined && !this.mechanicsConfig.infiniteStamina) {
      const player = this.player();
      player.runEnergy = {
        energy: Math.max(0, Math.min(RUN_ENERGY_MAX, player.runEnergy.energy + result.runEnergyDelta)),
      };
    }

    if (result.prayerPointsDelta !== undefined) {
      const player = this.player();
      const previousPoints = player.prayerState.points;
      player.prayerState = {
        ...player.prayerState,
        points: Math.max(
          0,
          Math.min(player.prayerState.maxPoints, player.prayerState.points + result.prayerPointsDelta),
        ),
      };
      if (previousPoints > 0 && player.prayerState.points === 0) this.finalizePrayerDepletion(this.worldState.tick);
    }
    if (result.playerStatDrains !== undefined) {
      const player = this.player();
      let stats = player.stats;
      for (const skill of RESTORABLE_STATS) {
        const amount = result.playerStatDrains[skill];
        if (amount !== undefined) stats = withStatCurrent(stats, skill, drainStat(stats[skill].current, amount));
      }
      player.stats = stats;
    }
    for (const splat of result.playerHitsplats ?? []) {
      this.tickEvents.emit({ type: 'hitsplat_spawned', targetId: PLAYER_ACTOR_ID, ...splat });
    }
    if (result.gameMessage) this.tickEvents.emit({ type: 'game_message', kind: 'game', segments: result.gameMessage });

    const fail = result.fail ?? null;
    if (fail && this.mechanicsConfig.infiniteStamina && fail === 'StaminaDepleted') return null;
    return fail;
  }

  /**
   * The weapon's ordinary attack, for the theoretical DPS projection. Where the player stands and
   * attacks follows the attack actually made, a manual cast included (`resolvePlayerAttackParams`).
   */
  private getPlayerCombatParams(player: PlayerActor): ReturnType<typeof getPlayerEffectiveCombatParams> {
    const params = getPlayerEffectiveCombatParams(player);
    const rules = this.getEncounterRules();
    if (rules?.modifyPlayerCombatParams) {
      return rules.modifyPlayerCombatParams(params, this.buildEngineContext());
    }
    return params;
  }

  private lookupItemStats(itemId: number): EquipmentStats | null {
    if (this.objTypeLoader === null) return null;
    try {
      return loadItemStats(itemId, this.objTypeLoader);
    } catch {
      return null;
    }
  }

  private buildCombatBridge(overrides?: Partial<CombatBridge>): CombatBridge {
    const rules = this.getEncounterRules();
    const ctx = this.buildEngineContext();
    return {
      events: this.tickEvents,
      infiniteHealth: this.mechanicsConfig.infiniteHealth,
      incomingDamageMultiplier: resolveDynamic(rules?.incomingDamageMultiplier, ctx),
      outgoingDamageMultiplier: resolveDynamic(rules?.outgoingDamageMultiplier, ctx),
      specDamageMultiplier: resolveDynamic(rules?.specialAttacks?.damageMultiplier, ctx),
      onDamageApplied: (info) => this.onCombatDamageApplied(info),
      onSourceSelfDamageApplied: () => this.tryRedemption(this.worldState.tick),
      ...overrides,
    };
  }

  private applyEncounterArenaConfig(encounter: Encounter): void {
    // Prefer the cache-resolved config for this encounter's (base) kind — the
    // encounter-agnostic default. It carries real map-square loc collision plus
    // any declared dynamic locs, and is installed once the cache has loaded
    // (see useEncounterManager). Keyed by base kind so contract variants and
    // encounter re-entry always reinstall this encounter's own collision.
    const baseKind = baseEncounterKind(encounter.kind);
    const resolved = getResolvedArenaConfig(baseKind);
    if (resolved && (resolved.bounds !== null || resolved.walkableTiles !== null || resolved.collisionMap !== null)) {
      setArenaConfig(encounter.refineArenaConfig?.(resolved) ?? resolved, false);
      return;
    }

    // Otherwise the encounter's own config: a 'custom' encounter (e.g. Lobby),
    // or the pre-cache placeholder for an 'auto' encounter. Unbounded fallback
    // only when the encounter itself declares no constraints.
    const arenaConfig = encounter.getArenaConfig();
    const hasConstraints =
      arenaConfig.bounds !== null || arenaConfig.walkableTiles !== null || arenaConfig.collisionMap !== null;
    setArenaConfig(encounter.refineArenaConfig?.(arenaConfig) ?? arenaConfig, !hasConstraints);
  }

  /** Re-apply arena config after cache finishes loading (walkable tiles now available). */
  reapplyArenaConfig(): void {
    this.applyEncounterArenaConfig(this.encounter);
  }

  private getEncounterDefaultPlayerStart(encounter: Encounter): Coordinate {
    return encounter.getDefaultPlayerStart(this.mechanicsConfig);
  }

  /**
   * The tick-zero world an encounter's `configureRunStart` may rebuild. An actor added here is
   * registered as `initializeWorld` registers `createNpcs` ones; one removed vanishes without an event,
   * since it has done nothing yet.
   */
  private runStartContext(): EncounterRunStartContext {
    return {
      world: this.worldState,
      spawnNpc: (actor) => this.admitOpeningNpc(actor),
      despawnNpc: (npcId) => {
        const npc = this.worldState.getNpc(npcId);
        if (!npc) return;
        this.worldState.removeActor(npcId);
        this.npcDefinitions.notifyDespawn(npc, this.buildNpcDefinitionContext());
      },
      placePlayer: (position) => {
        const player = this.player();
        this.runStartPosition = [...position] as Coordinate;
        player.position = [...position] as Coordinate;
        player.previousPosition = player.position;
        player.movementPath = [];
        player.isMoving = false;
        player.isRunning = false;
        player.facing = this.openingFacing();
        player.history.clear();
        player.history.set(SIMULATION_START_TICK, player.position);
        const occupancy = this.worldState.occupancy;
        occupancy.clear();
        for (const actor of this.worldState.actors.values()) occupancy.add(actor);
      },
    };
  }

  private admitOpeningNpc(npc: NpcActor): void {
    if (this.worldState.actors.has(npc.id)) throw new Error(`spawnNpc: duplicate actor id '${npc.id}'`);
    this.replayTakeoverWork?.admitNpcs(this.getNpcCount(), 1);
    this.npcDefinitions.validateActor(npc);
    this.applyEncounterMonsterStatOverride(npc);
    delete npc.crawlMovement;
    this.worldState.registerNpc(npc);
    npc.history.set(SIMULATION_START_TICK, npc.position);
  }

  private initializeWorld(playerStart: Coordinate, inventory: Inventory): void {
    this.worldState.tick = SIMULATION_START_TICK;
    this.worldState.pendingHits = [];
    this.worldState.nextHitSequence = 0;
    this.worldState.nextNpcProcessingOrder = 0;
    this.worldState.areaEffects = [];
    this.worldState.actors = new Map();
    this.worldState.occupancy.clear();
    this.worldState.groundItems = [];
    this.worldState.groundItemSeq = 0;
    // The run's setup chooses its intro (the Inferno lands only a run started on wave 1).
    const introConfig = this.setupIntro();
    this.startedIntro = introConfig;
    this.openingIntro = introConfig;
    this._introActive = introConfig !== null;

    const player = this.createPlayerActor(playerStart, inventory);
    player.facing = this.openingFacing();
    this.worldState.actors.set(player.id, player);
    this.worldState.occupancy.add(player);
    // Run setup first, so `createNpcs` opens the configured start (Inferno: wave 69's actors).
    this.encounter.configureRunStart?.(this.mechanicsConfig, this.runStartContext());
    const npcs = this.encounter.createNpcs(playerStart);
    this.replayTakeoverWork?.admitNpcs(0, npcs.length);
    for (const npc of npcs) {
      this.npcDefinitions.validateActor(npc);
      this.applyEncounterMonsterStatOverride(npc);
      delete npc.crawlMovement;
      this.worldState.registerNpc(npc);
      npc.history.set(SIMULATION_START_TICK, npc.position);
    }

    player.history.set(SIMULATION_START_TICK, player.position);
    const maxHpReduction = this.encounterRules?.playerMaxHpReduction;
    if (maxHpReduction !== undefined && maxHpReduction > 0 && maxHpReduction <= 1) {
      player.vitals.maxHp = Math.max(1, player.vitals.maxHp - Math.floor(player.vitals.maxHp * maxHpReduction));
      player.vitals.hp = Math.min(player.vitals.hp, player.vitals.maxHp);
    }
    // After the reduction, so the clamp uses the ceiling this encounter actually fights at.
    if (this.startHp !== undefined) {
      player.vitals.hp = Math.max(1, Math.min(Math.floor(this.startHp), player.vitals.maxHp));
    }
    this.syncVitalsToStats();

    this.logEvent({
      tick: SIMULATION_START_TICK,
      type: EventType.TICK_START,
      playerPosition: [...player.position] as Coordinate,
    });

    this.tickEvents.setTick(SIMULATION_START_TICK);
    if (introConfig) {
      this.tickEvents.emit({
        type: 'intro_started',
        animationSeqId: introConfig.animationSeqId,
        landingPosition: [...playerStart] as Coordinate,
      });
    }
    this.lastTickEvents = this.tickEvents.flush();
  }

  private createPlayerActor(startPos: Coordinate, inventory: Inventory): PlayerActor {
    const stats = cloneBaseStats(this.configuredStats);
    const prayerState = createDefaultPrayerState();
    prayerState.points = stats.prayer.current;
    prayerState.maxPoints = stats.prayer.max;
    return {
      id: PLAYER_ACTOR_ID,
      kind: 'player',
      alive: true,
      position: startPos,
      previousPosition: startPos,
      facing: 1024, // North
      size: 1,
      vitals: {
        hp: stats.hitpoints.current,
        maxHp: stats.hitpoints.max,
      },
      movementPath: [],
      isMoving: false,
      isRunning: false,
      history: new Map<TickNumber, Coordinate>(),
      activePrayer: null,
      boostPrayers: [],
      independentPrayers: [],
      prayerState,
      stats,
      poisonState: createDefaultPoisonState(),
      specialAttack: createDefaultSpecialAttack(),
      combatTimers: createDefaultTimers(),
      inventory,
      combatSupplies: createEmptyCombatSupplies(),
      isRunEnabled: true,
      isSpecialAttackActive: false,
      runEnergy: createDefaultRunEnergy(),
      ctrlClickOverride: false,
      equipment: {},
      equipmentStats: createEmptyEquipmentStats(),
      pendingInputOps: [],
      cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
      pendingItemPickup: null,
      activeEffects: [],
      quickPrayersActive: false,
      outline: { color: packHsl(144, 246, 104), style: 'full' },
      attackTarget: null,
      autoAttackPause: null,
      attackInteractionActive: true,
      manualCastSpell: null,
      selectedAttackStyleIndex: 0,
      pendingConflictionAttack: null,
      xpCounters: {},
    };
  }

  public setPlayerStats(stats: PlayerStats): void {
    this.configuredStats = cloneBaseStats(stats);
    const player = this.player();
    player.stats = cloneBaseStats(this.configuredStats);
    player.vitals = {
      hp: player.stats.hitpoints.current,
      maxHp: player.stats.hitpoints.max,
    };
    player.prayerState = {
      ...createDefaultPrayerState(),
      points: player.stats.prayer.current,
      maxPoints: player.stats.prayer.max,
    };
  }

  private player(): PlayerActor {
    const actor = this.worldState.getPlayer();
    if (!actor) {
      throw new Error('Player actor missing from world state');
    }
    return actor;
  }

  private logEvent(event: SimulationEvent): void {
    this.eventLog.push(event);
  }

  /**
   * advanceTick records one entry per actor per tick, so a single delete keeps
   * each history Map bounded to the window. These maps are unused by production
   * rendering (a recent trail + a couple of unit tests); bounding them keeps
   * every SimulationState — and therefore every replay-frame structuredClone —
   * O(1) instead of O(N), fixing the long-session OOM.
   */
  private recordActorHistory(history: Map<TickNumber, Coordinate>, tick: number, position: Coordinate): void {
    history.set(tick, position);
    history.delete(tick - ACTOR_HISTORY_WINDOW_TICKS);
  }

  /**
   * Remove dead, non-boss transient actors (e.g. exploded void flares) a short
   * grace period after death. They are no longer simulated, and the renderer
   * captures their death/fade animation into its own dyingInstances map the
   * first frame it sees alive=false — so pruning here does not cut the visual.
   * Left in worldState.actors they would accumulate without bound AND bloat
   * every replay-frame snapshot's npc list (each frame deep-clones state.npcs),
   * a primary long-session memory leak.
   */
  private pruneDeadActors(currentTick: number): void {
    let toRemove: NpcActor[] | null = null;
    for (const actor of this.worldState.actors.values()) {
      if (actor.alive || actor.kind !== 'npc') continue;
      const npc = actor as NpcActor;
      const graceStart = pruneGraceStartTick(npc);
      if (npc.role === 'boss' || npc.retainAfterDeath || graceStart === undefined) continue;
      if (currentTick - graceStart < DEAD_ACTOR_PRUNE_GRACE_TICKS) continue;
      if (toRemove === null) {
        toRemove = [];
      }
      toRemove.push(npc);
    }
    if (!toRemove) return;
    for (const npc of toRemove) {
      if (!isCurrentActorInstance(this.worldState, npc) || npc.alive) continue;
      const graceStart = pruneGraceStartTick(npc);
      if (npc.role === 'boss' || npc.retainAfterDeath || graceStart === undefined) continue;
      if (currentTick - graceStart < DEAD_ACTOR_PRUNE_GRACE_TICKS) continue;
      this.worldState.removeActor(npc.id);
      this.npcDefinitions.notifyDespawn(npc, this.buildNpcDefinitionContext());
    }
  }

  /** The player's mechanics. A run override from `reset` stays on top of them until the next reset. */
  public setMechanicsConfig(config: Partial<MechanicsConfig>): void {
    this.playerMechanicsConfig = { ...config };
    this.mergeMechanicsConfig();
    if (this.worldState.tick === SIMULATION_START_TICK) {
      this.encounter.configureRunStart?.(this.mechanicsConfig, this.runStartContext());
      this.reopenIntro();
    }
    // Unlock toggles are not changed mid-fight from the UI, but replay takeover applies the
    // viewer's settings to a recorded run, which can lock a prayer the recording had lit.
    if (this.worldState.getPlayer() !== null) {
      this.removeBoostPrayers(this.worldState.tick, (prayer) => !isPrayerUnlocked(prayer, this.mechanicsConfig));
    }
  }

  private setupIntro(): EncounterIntroConfig | null {
    return this._introEnabled ? this.encounter.getIntroConfig(this.mechanicsConfig) : null;
  }

  /**
   * A tick-zero setup edit (the practice pane saves a start wave as it is typed, and an unstarted run
   * takes it up) keeps the run's started intro while the new setup opens with the same one, and drops
   * it otherwise: no landing message on tick 1, and the setup's own opening facing. It never starts or
   * swaps an intro, and one already playing plays out: the animation is the renderer's, the countdown
   * waits on it, and starting one per keystroke would land a player typing "12" on wave 1. A replay
   * takes the same path, since reconstruction applies the first frame's setup at tick 0.
   */
  private reopenIntro(): void {
    const intro = this.setupIntro();
    const started = this.startedIntro;
    const kept =
      intro !== null &&
      started !== null &&
      intro.facingAngle === started.facingAngle &&
      intro.animationSeqId === started.animationSeqId &&
      intro.message === started.message
        ? started
        : null;
    if (kept === this.openingIntro) return;
    this.openingIntro = kept;
    this.player().facing = this.openingFacing();
  }

  /**
   * Keep this run's setup (the encounter's `runStartMechanicsKeys`, as configured now) over any player
   * mechanics set later, until the next reset. A reconstructed run calls this: its start is the
   * recording's, and a tick-zero `setMechanicsConfig` must not reconfigure it from the viewer's setup.
   */
  public keepRunStartSetup(): void {
    const setup = Object.fromEntries(
      (this.encounter.runStartMechanicsKeys ?? []).map((key) => [key, this.mechanicsConfig[key]]),
    );
    this.runMechanicsOverride = { ...this.runMechanicsOverride, ...setup };
    this.mergeMechanicsConfig();
  }

  private mergeMechanicsConfig(): void {
    this.mechanicsConfig = mergeMechanicsConfig(this.getEncounterDefaultMechanicsConfig(), {
      ...this.playerMechanicsConfig,
      ...this.runMechanicsOverride,
    });
  }

  public getEncounterDefaultMechanicsConfig(): Partial<MechanicsConfig> {
    return this.encounter.getDefaultMechanicsConfig();
  }

  /**
   * Replace the floor wholesale. For replay takeover, which rebuilds a world from a
   * recorded snapshot; the id sequence is advanced past everything restored so a
   * later drop cannot collide with a pile that came from the snapshot.
   */
  public setGroundItems(groundItems: readonly GroundItem[]): void {
    this.worldState.groundItems = groundItems.map((item) => ({
      ...item,
      position: [item.position[0], item.position[1]] as Coordinate,
    }));
    for (const item of this.worldState.groundItems) {
      const sequence = Number.parseInt(item.id.replace(/^gi-/, ''), 10);
      if (Number.isFinite(sequence) && sequence > this.worldState.groundItemSeq) {
        this.worldState.groundItemSeq = sequence;
      }
    }
  }

  public setInventory(inventory: Inventory): void {
    this.player().inventory = inventory;
    this.recalculateEquipmentStats();
  }

  public setCombatSupplies(supplies: CombatSupplies): void {
    const player = this.player();
    const previousSpellbook = player.combatSupplies.spellbook;
    player.combatSupplies = cloneCombatSupplies(supplies);
    if (player.combatSupplies.spellbook !== previousSpellbook) {
      this.syncAttackStyleForCurrentWeapon();
    }
  }

  public getCombatSupplies(): CombatSupplies {
    return cloneCombatSupplies(this.player().combatSupplies);
  }

  /** Set the autocast spell without disturbing the rest of the loadout's supplies. */
  public setSelectedSpell(spellName: string | null): void {
    const player = this.player();
    player.combatSupplies = { ...player.combatSupplies, selectedSpell: spellName };
  }

  public swapInventorySlots(indexA: number, indexB: number): void {
    const player = this.player();
    if (indexA === indexB) return;
    if (indexA < 0 || indexA >= player.inventory.length) return;
    if (indexB < 0 || indexB >= player.inventory.length) return;
    const newInventory = [...player.inventory];
    const temp = newInventory[indexA];
    newInventory[indexA] = newInventory[indexB];
    newInventory[indexB] = temp;
    player.inventory = newInventory;
  }

  public previewInventoryAfterEquipFromInventory(
    inventoryIndex: number,
    slot: keyof PlayerEquipment,
  ): Inventory | null {
    return (
      this.previewEquipFromInventoryState(this.player().inventory, this.player().equipment, inventoryIndex, slot)
        ?.inventory ?? null
    );
  }

  public previewEquipFromInventoryState(
    inventory: Inventory,
    equipment: PlayerEquipment,
    inventoryIndex: number,
    slot: keyof PlayerEquipment,
  ): InventoryEquipmentPreview | null {
    const invItem = inventory[inventoryIndex];
    if (!invItem) return null;

    const nextInventory = [...inventory];
    const equippingTwoHanded = slot === 'weapon' && this.isTwoHanded(invItem.id);
    const equippingShieldWhile2H =
      slot === 'shield' && equipment.weapon !== undefined && this.isTwoHanded(equipment.weapon);

    if (equippingTwoHanded) {
      const existingWeaponId = equipment.weapon;
      const existingShieldId = equipment.shield;
      if (existingShieldId !== undefined) {
        const emptySlots = this.countEmptySlotsInInventory(inventory, inventoryIndex);
        const availableForShield = emptySlots - (existingWeaponId !== undefined ? 1 : 0);
        if (availableForShield < 1) return null;
      }
      nextInventory[inventoryIndex] = existingWeaponId !== undefined ? { id: existingWeaponId } : null;
      if (existingShieldId !== undefined) {
        const emptyIndex = nextInventory.indexOf(null);
        if (emptyIndex !== -1) nextInventory[emptyIndex] = { id: existingShieldId };
      }
      return {
        inventory: nextInventory,
        equipment: { ...equipment, weapon: invItem.id, shield: undefined },
      };
    }

    if (equippingShieldWhile2H) {
      const existing2HId = equipment.weapon;
      const existingShieldId = equipment.shield;
      if (existing2HId !== undefined) {
        const emptySlots = this.countEmptySlotsInInventory(inventory, inventoryIndex);
        const availableFor2H = emptySlots - (existingShieldId !== undefined ? 1 : 0);
        if (availableFor2H < 1) return null;
      }
      nextInventory[inventoryIndex] = existingShieldId !== undefined ? { id: existingShieldId } : null;
      if (existing2HId !== undefined) {
        const emptyIndex = nextInventory.indexOf(null);
        if (emptyIndex !== -1) nextInventory[emptyIndex] = { id: existing2HId };
      }
      return {
        inventory: nextInventory,
        equipment: { ...equipment, weapon: undefined, shield: invItem.id },
      };
    }

    const existingItemId = equipment[slot];
    nextInventory[inventoryIndex] = existingItemId !== undefined ? { id: existingItemId } : null;
    return {
      inventory: nextInventory,
      equipment: { ...equipment, [slot]: invItem.id },
    };
  }

  public previewInventoryAfterUnequip(slot: keyof PlayerEquipment): Inventory | null {
    return this.previewUnequipState(this.player().inventory, this.player().equipment, slot)?.inventory ?? null;
  }

  public previewUnequipState(
    inventory: Inventory,
    equipment: PlayerEquipment,
    slot: keyof PlayerEquipment,
  ): InventoryEquipmentPreview | null {
    const itemId = equipment[slot];
    if (itemId === undefined) return null;
    const emptyIndex = inventory.indexOf(null);
    if (emptyIndex === -1) return null;
    const nextInventory = [...inventory];
    nextInventory[emptyIndex] = { id: itemId };
    return {
      inventory: nextInventory,
      equipment: { ...equipment, [slot]: undefined },
    };
  }

  /**
   * Client-prediction preview of the inventory after equipping ammo from a slot.
   * Mirrors the authoritative `equip_ammo` tick handler: merging onto a matching
   * equipped stack empties the slot, otherwise the previously equipped ammo swaps
   * back into it. Pure: returns the projected inventory (equipped ammo lives in
   * combat supplies, not equipment). Returns null when the slot is empty.
   */
  public previewEquipAmmoFromInventory(
    inventory: Inventory,
    supplies: CombatSupplies,
    inventoryIndex: number,
  ): Inventory | null {
    const inventoryAmmo = inventory[inventoryIndex];
    if (!inventoryAmmo) return null;
    const equippedAmmo = supplies.equippedAmmo;
    const nextInventory = [...inventory];
    if (equippedAmmo?.id === inventoryAmmo.id) {
      nextInventory[inventoryIndex] = null;
    } else {
      nextInventory[inventoryIndex] = equippedAmmo === null ? null : { ...equippedAmmo };
    }
    return nextInventory;
  }

  /**
   * Client-prediction preview of the inventory after unequipping ammo. Mirrors
   * the `unequip_ammo` tick handler: the equipped stack drops into the first
   * empty inventory slot. Returns null when there is no equipped ammo or no free
   * inventory slot.
   */
  public previewUnequipAmmo(inventory: Inventory, supplies: CombatSupplies): Inventory | null {
    const equippedAmmo = supplies.equippedAmmo;
    if (equippedAmmo === null) return null;
    const emptyIndex = inventory.indexOf(null);
    if (emptyIndex === -1) return null;
    const nextInventory = [...inventory];
    nextInventory[emptyIndex] = { ...equippedAmmo };
    return nextInventory;
  }

  public advanceTick(playerClickTarget: Coordinate): void {
    if (!this.canAdvance()) {
      return;
    }
    const work = this.replayTakeoverWork;
    work?.beginTick(this.getNpcCount());
    try {
      this.advanceTickUnchecked(playerClickTarget);
    } finally {
      work?.endTick();
    }
  }

  public getNpcCount(): number {
    return this.worldState.actors.size - 1;
  }

  public releaseReplayTakeoverLimits(): void {
    this.replayTakeoverWork = undefined;
  }

  public continueEventIdsAfter(eventId: number): void {
    this.tickEvents.continueAfter(eventId);
  }

  private advanceTickUnchecked(playerClickTarget: Coordinate): void {
    const player = this.player();
    const previousTick = this.worldState.tick;
    const nextTick = previousTick + 1;
    // Captured before anything can spend it — `tickSpecialAttack` needs the bar as it stood at the
    // START of the tick to decide whether a regen cycle was running at all.
    const specEnergyAtTickStart = player.specialAttack.energy;
    // Before anything that can return early or set it, so it only ever answers for this tick.
    this.walkTargetDiscarded = false;

    this.worldState.tick = nextTick;
    this.tickEvents.setTick(nextTick);

    this.logEvent({
      tick: nextTick,
      type: EventType.TICK_START,
      playerPosition: [...player.position] as Coordinate,
    });

    const landingMessage = this.openingIntro?.message;
    if (nextTick === SIMULATION_START_TICK + 1 && landingMessage !== undefined) {
      this.tickEvents.emit({ type: 'game_message', kind: 'game', segments: [{ text: landingMessage }] });
    }

    // First, so whatever a command spawns carries this tick and exists in its first snapshot.
    this.runPendingEncounterCommands();

    const rules = this.getEncounterRules();
    if (rules?.onTickStart) {
      const result = rules.onTickStart(this.buildPlayerLockContext());
      const fail = this.processHookResult(result);
      if (fail) {
        this.applyFailCondition(fail, nextTick);
        this.lastTickEvents = this.tickEvents.flush();
        return;
      }
    }

    // A locked player loses this tick's inputs and walk; everything else runs on.
    if (nextTick < this.playerActionsUnlockTick) {
      player.pendingInputOps = [];
      this.pendingEquipmentSlotClicks = [];
      this.endPlayerInteraction();
    }

    // BAND 2 — INPUT. Every client op for this tick, in click order.
    this.processInputBand(nextTick);

    // A self-damage item applied its HP loss mid-FIFO but could not adjudicate Redemption there,
    // because a prayer clicked after the item was not lit yet. Resolve it now, with the band
    // drained and before any other damage source runs: deferring further would let a hazard or NPC
    // hit land in between and kill a player whose proc was already earned.
    if (this.selfDamageHitPending) {
      this.selfDamageHitPending = false;
      this.tryRedemption(nextTick);
    }

    const encounterMechanics = this.getEncounterMechanics();

    const equipmentSlotClicks = [...this.pendingEquipmentSlotClicks];
    this.pendingEquipmentSlotClicks = [];
    const encounterInputs: EncounterInputState = { equipmentSlotClicks };
    const npcMovements = new Map<string, NpcMovementInfo>();
    const setProtectionPrayer = (prayer: PrayerType | null): void => this.forceSetProtectionPrayer(prayer);

    const prePlayerMoveCtx = this.buildEncounterCtx(
      nextTick,
      player.position,
      encounterInputs,
      npcMovements,
      setProtectionPrayer,
    );

    for (const damage of this.encounter.resolveHazards(prePlayerMoveCtx, encounterMechanics)) {
      this.applyEnvironmentalDamage(damage, nextTick);
    }

    this.processNpcBand(prePlayerMoveCtx, encounterMechanics, npcMovements);

    this.processPlayerQueueBand();
    this.processPlayerTimerBand(nextTick, previousTick, specEnergyAtTickStart);
    cancelBlockedPlayerAttack(player, this.worldState);

    // BAND 4 — PLAYER pre-move interaction. Runs before the step below because standing
    // on the tile is a precondition, not something this tick's step can satisfy: clicking a
    // pile you are already on takes one tick, walking to one takes the arrival tick plus one.
    this.processItemPickup();

    const prevPlayerPos = player.position;
    const effectiveRunning = player.ctrlClickOverride ? !player.isRunEnabled : player.isRunEnabled;
    const shouldRun = effectiveRunning && player.runEnergy.energy > 0;

    let movementResult: MovementResult;
    const attackNpc = player.attackTarget ? this.worldState.actors.get(player.attackTarget) : undefined;
    const interactionNpc = this.getNpcInteractionTarget(player);
    // Locked or teleported earlier this tick: the walk target is no longer the player's to follow.
    if (this.walkTargetDiscarded) {
      movementResult = { position: [...player.position] as Coordinate, stepTiles: [] };
    } else if (interactionNpc) {
      movementResult = playerMoveToNpc(player.position, interactionNpc.position, interactionNpc.size, shouldRun);
    } else if (attackNpc !== undefined && canPlayerStartAttackOn(player, attackNpc) && attackNpc.kind === 'npc') {
      const npc = attackNpc as NpcActor;
      const { attackRange, meleeReach } = resolvePlayerAttackParams(player, {
        world: this.worldState,
        encounterRules: this.getEncounterRules(),
      });
      const underNpc = isUnderNpc(player.position, npc.position, npc.size);
      // OSRS "drag to melee" behavior: when interaction is canceled by an
      // interface action (eat/equip/drink), movement continues to melee range
      // (range 1) regardless of the weapon's actual attack range.
      const effectiveRange = player.attackInteractionActive ? attackRange : 1;
      const effectiveReach = player.attackInteractionActive ? meleeReach : 'cardinal';
      if (!underNpc && isInAttackRange(player.position, npc.position, npc.size, effectiveRange, true, effectiveReach)) {
        movementResult = { position: [...player.position] as Coordinate, stepTiles: [] };
      } else {
        movementResult = playerMoveToNpc(player.position, npc.position, npc.size, shouldRun);
      }
    } else {
      movementResult = playerMoveAutopath(player.position, playerClickTarget, shouldRun);
    }
    const didMove = this.applyPlayerMovement(player, movementResult);

    this.recordActorHistory(player.history, nextTick, player.position);

    if (didMove) {
      this.logEvent({
        tick: nextTick,
        type: EventType.PLAYER_MOVE,
        from: [...prevPlayerPos] as Coordinate,
        to: [...player.position] as Coordinate,
      });

      this.tickEvents.emit({
        type: 'movement',
        actorId: player.id,
        from: [...prevPlayerPos] as Coordinate,
        to: [...player.position] as Coordinate,
      });
    }

    // BAND 4 — PLAYER post-move interaction.
    processPlayerAutoAttack(player, {
      random: this.rollCombat,
      world: this.worldState,
      tickEvents: this.tickEvents,
      combatSystem: this.combatSystem,
      infiniteHealth: this.mechanicsConfig.infiniteHealth,
      encounterRules: this.getEncounterRules(),
      combatSupplies: player.combatSupplies,
      lookupItemStats: (itemId): EquipmentStats | null => this.lookupItemStats(itemId),
      onPlayerAttackStarted: (info): void => {
        this.encounter.onPlayerAttackStarted?.(info, {
          world: this.worldState,
          tickEvents: this.tickEvents,
          spawnNpc: (actor) => this.spawnEncounterNpc(actor),
          despawnNpc: (npcId) => this.despawnEncounterNpc(npcId),
        });
      },
      onDamageApplied: (info: DamageAppliedInfo): void => {
        this.onCombatDamageApplied(info);
      },
    });
    // After the attack band, so an axe attack on the decay tick re-arms the clock (and rolls with
    // every stack) before any stack can decay.
    player.soulreaper = tickSoulreaperDecay(player.soulreaper, nextTick);

    const postPlayerMoveCtx = this.buildEncounterCtx(
      nextTick,
      player.position,
      encounterInputs,
      npcMovements,
      setProtectionPrayer,
    );
    if (
      interactionNpc &&
      !this.walkTargetDiscarded &&
      isInAttackRange(player.position, interactionNpc.position, interactionNpc.size, 1, true) &&
      !isUnderNpc(player.position, interactionNpc.position, interactionNpc.size)
    ) {
      player.pendingNpcInteraction = undefined;
      this.encounter.onNpcInteraction?.({ kind: 'npcInteraction', targetId: interactionNpc.id }, postPlayerMoveCtx);
    }
    for (const damage of this.encounter.processPostTick(postPlayerMoveCtx, encounterMechanics)) {
      this.applyEnvironmentalDamage(damage, nextTick);
    }

    // Reads the steps just taken, so it closes the player band — as in rsmod,
    // which updates run energy post-tick.
    const staminaActive = player.activeEffects.some((effect) => effect.type === 'stamina');
    player.runEnergy = tickRunEnergy(player.runEnergy, {
      isRunning: player.isRunning,
      agility: player.stats.agility.current,
      // ObjTypeLoader caches decoded items; derive from the live loadout so consumption,
      // swaps, and every other inventory mutation are reflected without invalidation hooks.
      weight: this.objTypeLoader ? computeTotalWeight(player.equipment, player.inventory, this.objTypeLoader) : 0,
      gracefulBonusPercent: gracefulRegenBonusPercent(player.equipment),
      staminaActive,
      ringOfEnduranceEquipped: player.equipment.ring === RING_OF_ENDURANCE_ITEM_ID,
    });

    if (player.runEnergy.energy <= 0 && player.isRunEnabled) {
      player.isRunEnabled = false;
    }

    // BAND 5 — POST. Adjudication must see every same-tick damage source, and
    // pruning must follow it so encounter callbacks can still inspect the dead.
    this.adjudicateNpcDefeats(postPlayerMoveCtx);
    this.expireTimedProtectionPrayer(nextTick);
    this.pruneDeadActors(nextTick);

    this.lastTickEvents = this.tickEvents.flush();
  }

  /**
   * Apply one turn's player steps: position, the route the renderer walks, entity collision flags,
   * the moving/running flags and facing. Returns whether the player changed tile.
   */
  private applyPlayerMovement(player: PlayerActor, movementResult: MovementResult): boolean {
    const prevPlayerPos = player.position;
    const newPlayerPos = movementResult.position;

    if (!isValidArenaCoordinate(newPlayerPos)) {
      player.position = prevPlayerPos;
      player.previousPosition = prevPlayerPos;
      player.movementPath = [];
    } else {
      player.previousPosition = prevPlayerPos;
      player.position = newPlayerPos;
      player.movementPath = movementResult.stepTiles.map(([x, y]) => [x, y] as Coordinate);
      // Each step, a run's middle tile included, leaves and enters entity collision flags. Placements
      // since the last NPC turn are reconciled first (the player's turn boundary).
      const occupancy = this.worldState.occupancy;
      occupancy.reconcile(this.worldState.actors.values());
      let stepFrom = prevPlayerPos;
      for (const tile of player.movementPath) {
        occupancy.step(player, stepFrom, tile);
        stepFrom = tile;
      }
    }

    const didMove = prevPlayerPos[0] !== player.position[0] || prevPlayerPos[1] !== player.position[1];
    player.isMoving = didMove;
    player.isRunning = didMove && player.movementPath.length > 1;

    if (didMove) {
      const lastStep = player.movementPath[player.movementPath.length - 1];
      const secondToLast =
        player.movementPath.length > 1 ? player.movementPath[player.movementPath.length - 2] : prevPlayerPos;
      player.facing = this.calculateAngleFromDelta(
        lastStep[0] - secondToLast[0],
        lastStep[1] - secondToLast[1],
        player.facing,
      );
    }
    return didMove;
  }

  /**
   * One countdown positioning step of an unstarted run: ground-walk toward `target` by the ordinary
   * walk/run rules, and nothing else. The tick, encounter, NPCs, combat, prayer, run energy, timers,
   * RNG and pending inputs are untouched; the queued inputs still reach tick 1. Run follows the
   * preference tick 1 will apply: queued run-orb clicks flip it and drop a Ctrl-click override, as
   * the input band does. Returns the step for presentation, or null when the player stayed put.
   *
   * Only for a run at tick 0 past its intro; {@link finalizeStartPosition} must follow before tick 1.
   * See docs/architecture/movement-and-facing.md#countdown-start-positioning.
   */
  public prepareStartPosition(target: Coordinate): StartPositionStep | null {
    this.assertUnstartedRun('prepareStartPosition');
    const player = this.player();
    if (!player.alive) return null;
    const runToggles = player.pendingInputOps.filter((op) => op.type === 'run_toggle').length;
    const runEnabled = runToggles % 2 === 1 ? !player.isRunEnabled : player.isRunEnabled;
    const ctrlClickOverride = runToggles > 0 ? false : player.ctrlClickOverride;
    const shouldRun = (ctrlClickOverride ? !runEnabled : runEnabled) && player.runEnergy.energy > 0;
    const from = player.position;
    if (!this.applyPlayerMovement(player, playerMoveAutopath(from, target, shouldRun))) return null;
    return {
      from: [...from] as Coordinate,
      stepTiles: player.movementPath.map(([x, y]) => [x, y] as Coordinate),
      to: [...player.position] as Coordinate,
      isRunning: player.isRunning,
    };
  }

  /**
   * Commit the countdown's chosen tile as this run's start, exactly as if the run had been built
   * there: the start position a reconstruction uses, stationary opening locomotion and facing, the
   * opening history entry, and entity collision flags rebuilt as a fresh world adds them. Seeds,
   * loadout, mechanics, run overrides and queued inputs are kept; `reset` would reroll and drop them.
   *
   * Sound only because no encounter derives its opening NPC state from the player start (see
   * docs/architecture/encounters.md#determinism-and-run-setup).
   */
  public finalizeStartPosition(): void {
    this.assertUnstartedRun('finalizeStartPosition');
    const player = this.player();
    const start = [...player.position] as Coordinate;
    this.runStartPosition = [...start] as Coordinate;
    player.position = start;
    player.previousPosition = start;
    player.movementPath = [];
    player.isMoving = false;
    player.isRunning = false;
    player.facing = this.openingFacing();
    player.history.clear();
    player.history.set(SIMULATION_START_TICK, start);
    const occupancy = this.worldState.occupancy;
    occupancy.clear();
    for (const actor of this.worldState.actors.values()) occupancy.add(actor);
    const opening = this.eventLog[0];
    if (opening?.type === EventType.TICK_START && opening.tick === SIMULATION_START_TICK) {
      this.eventLog[0] = { ...opening, playerPosition: [...start] as Coordinate };
    }
  }

  private assertUnstartedRun(operation: string): void {
    if (this.worldState.tick !== SIMULATION_START_TICK || this._introActive) {
      throw new Error(`${operation} needs an unstarted run past its intro`);
    }
  }

  /** The facing a run opens with: the landing intro's, else north. */
  private openingFacing(): number {
    return this.openingIntro?.facingAngle ?? 1024;
  }

  /**
   * BAND 3 — NPC (`docs/architecture/npc-hit-queue-and-death.md`, section 2). Retaliation, then the
   * encounter's once-per-tick preparation, then one complete turn per NPC in `processingOrder`, then
   * the encounter's once-per-tick completion. The roster is walked live: an NPC registered during the
   * band takes its turn after every NPC registered before it (W69 t877: Jad's healers, spawned by his
   * half-health hit, cast that tick; Inferno split children and revived NPCs take an ordinary first
   * step, so the captured add tile is where it ended). One registered before the turns (a command,
   * `prepareNpcBand`) or after them first moves and acts next tick. One removed or replaced before its
   * turn loses it, and no instance gets two turns in a tick.
   */
  private processNpcBand(
    ctx: EncounterContext,
    mechanics: Partial<MechanicsConfig>,
    npcMovements: Map<string, NpcMovementInfo>,
  ): void {
    // A pre-pass, not part of each turn: a reaction only ever comes from a player attack, which is
    // committed in the player band or at launch, never inside this band. Running them all first keeps
    // `docs/architecture/npc-retaliation.md`'s order ("processNpcRetaliations runs first in the NPC band").
    processNpcRetaliations(this.worldState);
    this.encounter.prepareNpcBand?.(ctx, mechanics);
    const hitBridge = this.buildCombatBridge();
    const hadTurn = new Set<NpcActor>();
    let lastOrder = Number.NEGATIVE_INFINITY;
    this.npcTurnsRunning = true;
    try {
      for (;;) {
        const npc = this.nextNpcInProcessingOrder(lastOrder);
        if (npc === null) break;
        lastOrder = npc.processingOrder ?? lastOrder;
        // A re-registered instance has a new, later order; it has already had this tick's turn.
        if (hadTurn.has(npc)) continue;
        hadTurn.add(npc);
        this.runNpcTurn(npc, ctx, mechanics, npcMovements, hitBridge);
      }
    } finally {
      this.npcTurnsRunning = false;
    }
    for (const damage of this.encounter.completeNpcBand?.(ctx, mechanics) ?? []) {
      this.applyEnvironmentalDamage(damage, ctx.tick);
    }
  }

  /**
   * The registered NPC with the lowest processing order after `afterOrder`, read from the world each
   * time so a registration made by an earlier turn is seen. An NPC must be registered to take a turn.
   */
  private nextNpcInProcessingOrder(afterOrder: number): NpcActor | null {
    let next: NpcActor | null = null;
    for (const npc of this.worldState.getNpcs()) {
      const order = npc.processingOrder;
      if (order === undefined) {
        throw new Error(`NPC '${npc.id}' is in the world without a processing order; register it with registerNpc`);
      }
      if (order <= afterOrder) continue;
      if (next === null || order < (next.processingOrder ?? order)) next = npc;
    }
    return next;
  }

  /**
   * One NPC's turn: its removal if due (`Encounter.removeNpcIfDue`), its incoming hits and any death now due, its burn, poison and regeneration, then —
   * if its life state still allows a turn — its movement, local effects and action. Attacks the action
   * returns are committed at once, so a later NPC's turn already sees them.
   */
  private runNpcTurn(
    npc: NpcActor,
    ctx: EncounterContext,
    mechanics: Partial<MechanicsConfig>,
    npcMovements: Map<string, NpcMovementInfo>,
    hitBridge: CombatBridge,
  ): void {
    const tick = ctx.tick;
    this.encounter.removeNpcIfDue?.(npc, ctx, mechanics);
    if (!isCurrentActorInstance(this.worldState, npc)) return;
    this.reconcileNpcCrawlMovement(npc, tick);
    this.combatSystem.processPendingHitsForTarget(this.worldState, hitBridge, npc);
    if (!isCurrentActorInstance(this.worldState, npc)) return;
    if (isNpcDeathDue(npc, tick)) this.startNpcDeath(npc);
    // Told once per life (`claimNpcDeathAnimation`): a death processed this turn may already have been.
    if (isNpcDeathAnimationDue(npc, tick)) {
      this.npcDefinitions.notifyDeathAnimation(npc, this.buildNpcDefinitionContext());
    }
    // A timer kill made here waits for K+1: its death is never due this turn.
    this.combatSystem.processBurnStacks(this.worldState, hitBridge, npc);
    this.combatSystem.processNpcPoison(this.worldState, hitBridge, npc);
    advanceNpcHitpointRegen(npc, tick);
    if (!isCurrentActorInstance(this.worldState, npc)) return;

    const target = npc.combat.targetId === null ? undefined : this.worldState.actors.get(npc.combat.targetId);
    npc.combat.startedTurnOverlappingTarget = target?.alive === true && npcFootprintsOverlap(npc, target);
    npc.previousPosition = npc.position;
    npc.movementPath = [];
    npc.isMoving = false;
    npc.isRunning = false;
    if (isNpcDeathReleaseDue(npc, tick)) {
      // A windup it committed to before dying still launches on its death-animation tick (Jal-Ak, Q t3860).
      for (const attack of this.npcDefinitions.releaseOnDeathAnimation(npc, this.buildNpcDefinitionContext())) {
        if (!isCurrentActorInstance(this.worldState, npc)) break;
        this.commitNpcDeathRelease(npc, attack);
      }
      return;
    }
    if (!canNpcActThisTurn(npc, tick)) return;
    // Added this tick before the turns began: its first movement and action are next tick.
    if (this.addedOutsideNpcTurns.get(npc) === tick) return;

    // The turn boundary for collision flags: placements made since (a resurface, a teleport) leave
    // and enter now. Spawns and removals already updated them as they happened.
    this.worldState.occupancy.reconcile(this.worldState.actors.values());
    const requests = this.encounter.moveNpc
      ? this.encounter.moveNpc(npc, ctx, mechanics)
      : this.npcDefinitions.move(npc, this.buildNpcDefinitionContext());
    for (const request of requests) {
      // A movement callback that removed or replaced this NPC ends its turn.
      if (!isCurrentActorInstance(this.worldState, npc)) return;
      this.applyNpcMovement(npc, request, npcMovements);
    }
    if (!isCurrentActorInstance(this.worldState, npc)) return;
    this.reconcileNpcCrawlMovement(npc, tick);
    this.faceStationaryNpcTarget(npc);
    // Includes a pending-death NPC's permitted turn, whose final step the death animation waits on.
    this.recordActorHistory(npc.history, tick, npc.position);

    for (const damage of this.encounter.resolveNpcLocalEffects?.(npc, ctx, mechanics) ?? []) {
      this.applyEnvironmentalDamage(damage, tick);
    }
    if (!isCurrentActorInstance(this.worldState, npc) || !canNpcActThisTurn(npc, tick)) return;
    const result = this.encounter.processNpcTick?.(npc, ctx, mechanics);
    if (!result) return;
    for (const attack of result.npcAttacks ?? []) {
      // The turn's attacks belong to the instance that took it: once its action hook (or an earlier commit's
      // callback) removed or replaced it, the rest are dropped, never re-bound to a same-id successor.
      if (!isCurrentActorInstance(this.worldState, npc)) break;
      this.commitNpcAttack(npc, attack, tick);
    }
    for (const damage of result.environmentalDamages) this.applyEnvironmentalDamage(damage, tick);
  }

  private reconcileNpcCrawlMovement(npc: NpcActor, tick: number): void {
    const crawl = npc.crawlMovement;
    if (
      crawl &&
      (tick >= crawl.startTick + 2 ||
        tick < crawl.startTick ||
        npc.position[0] !== crawl.to[0] ||
        npc.position[1] !== crawl.to[1])
    )
      delete npc.crawlMovement;
  }

  private applyNpcMovement(
    npc: NpcActor,
    request: NpcMovementRequest,
    npcMovements: Map<string, NpcMovementInfo>,
  ): void {
    if (request.npcId !== npc.id) {
      throw new Error(`NPC '${npc.id}' returned a movement request for '${request.npcId}' from its own turn`);
    }
    const tick = this.worldState.tick;
    const from: Coordinate = [...npc.position];
    let path = isNpcMovementSuppressed(npc, this.player(), tick) ? [] : request.path;
    if (request.movementSpeed === 'crawl' && path.length > 0) {
      const step = path[0];
      const dx = step[0] - from[0];
      const dy = step[1] - from[1];
      // Invalid crawl requests are no-ops, not teleports or partially accepted runs.
      if (
        path.length !== 1 ||
        !Number.isInteger(dx) ||
        !Number.isInteger(dy) ||
        Math.max(Math.abs(dx), Math.abs(dy)) !== 1
      )
        path = [];
    }
    const dest = path.length > 0 ? path[path.length - 1] : from;
    const moved = dest[0] !== from[0] || dest[1] !== from[1];
    if (moved) {
      if (request.movementSpeed === 'crawl') {
        npc.crawlMovement = { from: [...from], to: [...dest], startTick: tick };
      } else {
        delete npc.crawlMovement;
      }
      let stepFrom = from;
      for (const tile of path) {
        this.worldState.occupancy.step(npc, stepFrom, tile);
        stepFrom = tile;
      }
      npc.position = [dest[0], dest[1]] as Coordinate;
      npc.movementPath = path.map(([x, y]) => [x, y] as Coordinate);
      npc.isMoving = true;
      recordNpcStep(npc, tick);
      npc.isRunning = path.length > 1;
      const prevStep = path.length > 1 ? path[path.length - 2] : from;
      npc.facing =
        npc.lockedFacing ?? this.calculateAngleFromDelta(dest[0] - prevStep[0], dest[1] - prevStep[1], npc.facing);
      this.tickEvents.emit({
        type: 'movement',
        actorId: npc.id,
        from: [...from] as Coordinate,
        to: [...npc.position] as Coordinate,
      });
    }
    npcMovements.set(npc.id, {
      npcId: npc.id,
      from,
      to: [...npc.position] as Coordinate,
      path: npc.movementPath ?? [],
      moved,
    });
  }

  /** See {@link EncounterContext.queueNpcHit}. */
  private queueNpcHit(npcAttack: NpcAttackRequest): void {
    const attacker = this.worldState.getNpc(npcAttack.attackerId);
    if (!attacker) throw new Error(`queueNpcHit: attacker '${npcAttack.attackerId}' is not registered`);
    const target = this.worldState.actors.get(npcAttack.targetId);
    if (!target) return;
    this.combatSystem.queueHitRequest(
      this.worldState,
      { attacker, target, attack: npcAttack },
      this.buildCombatBridge(),
    );
  }

  private commitNpcAttack(attacker: NpcActor, npcAttack: NpcAttackRequest, tick: number): void {
    if (npcAttack.attackerId !== attacker.id) {
      throw new Error(`NPC '${attacker.id}' returned an attack for '${npcAttack.attackerId}' from its own turn`);
    }
    const target = this.worldState.actors.get(npcAttack.targetId);
    if (!target) return;
    const request = { attacker, target, attack: npcAttack };
    const bridge = this.buildCombatBridge({ enablePendingHits: true });
    const committed = npcAttack.isContinuation
      ? this.combatSystem.processSupplementalHitRequest(this.worldState, request, bridge)
      : this.combatSystem.processAttackRequest(this.worldState, request, bridge);
    if (committed && !npcAttack.isContinuation) attacker.combat.lastAttackTick = tick;
  }

  private commitNpcDeathRelease(attacker: NpcActor, npcAttack: NpcAttackRequest): void {
    if (npcAttack.attackerId !== attacker.id) {
      throw new Error(`NPC '${attacker.id}' released an attack for '${npcAttack.attackerId}' as it died`);
    }
    const target = this.worldState.actors.get(npcAttack.targetId);
    if (!target) return;
    this.combatSystem.processDeathReleaseRequest(
      this.worldState,
      { attacker, target, attack: npcAttack },
      this.buildCombatBridge({ enablePendingHits: true }),
    );
  }

  /** Death processing plus the definition's own cleanup (`onDeathStarted`). */
  private startNpcDeath(npc: NpcActor): void {
    startNpcDeath(npc);
    this.npcDefinitions.notifyDeathStarted(npc, this.buildNpcDefinitionContext());
  }

  private processPlayerQueueBand(): void {
    // BAND 4 — PLAYER queues. A hit that came due this tick lands before any timer
    // or player action, as in rsmod: it resolves hits from the entity queue stage
    // (`hit_queues.standard`/`impact`) and runs queues ahead of timers and
    // interaction. So a lethal projectile kills before the player's own attack.
    this.combatSystem.processPendingHits(this.worldState, this.buildCombatBridge(), 'player');
  }

  private processPlayerTimerBand(nextTick: number, previousTick: number, specEnergyAtTickStart: number): void {
    const player = this.player();
    // BAND 4 — PLAYER timers. Everything here runs after the tick's input and
    // before movement and the player's attack: rsmod drains prayer and applies
    // poison damage from soft timers, and the timer stage precedes
    // `processInteractions` where movement and attacks live.
    // A boost or prayer that expires on this tick therefore does not apply to it.
    this.processActiveEffects(nextTick);
    this.processPoison(nextTick);

    const prayerRules = this.getEncounterRules()?.prayerDrain;
    const prayerDrainModifiers = prayerRules
      ? {
          drainMultiplier: prayerRules.multiplier,
          modifyDrainResistance: prayerRules.modifyDrainResistance
            ? (params: EncounterPrayerDrainParams) =>
                prayerRules.modifyDrainResistance!(params, this.buildEngineContext())
            : undefined,
        }
      : undefined;
    const prayerResult = tickPrayerDrain(
      player.prayerState,
      player.equipmentStats.prayer,
      nextTick,
      prayerDrainModifiers,
    );
    player.prayerState = prayerResult.state;
    if (prayerResult.drained) {
      this.finalizePrayerDepletion(nextTick);
    }

    // Re-read the ring every tick rather than on equip alone: a mid-fight inventory switch changes
    // it without going through any equipment entry point.
    player.specialAttack = syncLightbearer(player.specialAttack, player.equipment.ring === LIGHTBEARER_ITEM_ID);
    player.specialAttack = this.mechanicsConfig.infiniteSpecialAttack
      ? refillSpecialAttack(player.specialAttack)
      : tickSpecialAttack(player.specialAttack, specEnergyAtTickStart);
    const prevMarkOfDarknessTicks = player.combatTimers.markOfDarknessActiveTicks;
    // The last proc paying out zeroes the window itself, so only a charge that times out with a proc
    // still pending is seen running down to 0 here.
    const deathChargeFading =
      player.combatTimers.deathChargeActiveTicks > 0 && player.combatTimers.deathChargeProcsRemaining > 0;
    player.combatTimers = tickCombatTimers(player.combatTimers);
    // Decay locks are released before natural change below, so a lock ending this tick cannot also
    // shield this tick's decay.
    const lockResult = expireStatDecayLocks(player.stats, player.combatTimers);
    player.stats = lockResult.stats;
    player.combatTimers = lockResult.timers;
    if (lockResult.expired.includes('saturated_heart')) {
      this.tickEvents.emit({
        type: 'status_effect_expired',
        effect: 'saturated_heart',
      });
    }
    if (prevMarkOfDarknessTicks > 0 && player.combatTimers.markOfDarknessActiveTicks === 0) {
      this.tickEvents.emit({
        type: 'status_effect_expired',
        effect: 'mark_of_darkness',
      });
    }
    if (deathChargeFading && player.combatTimers.deathChargeActiveTicks === 0) {
      this.tickEvents.emit({
        type: 'status_effect_expired',
        effect: 'death_charge',
      });
    }

    // Cycles are booked against `previousTick`; the prayer checks read `nextTick` because that is
    // the tick activation stamps are written with. Prayer drain ran first, so a prayer that went
    // dark on this tick neither postpones a decay nor fires Rapid Restore.
    const naturalChange = tickNaturalStatChange(
      player.stats,
      player.combatTimers,
      previousTick,
      // Preserve only postpones a drain once it has been lit for 25 ticks; that gate is what stops
      // a flick timed just before the check from buying the extension.
      isPreserveQualified(player.prayerState, nextTick),
      isRapidRestoreDue(player.prayerState, nextTick),
    );
    player.stats = naturalChange.stats;
    player.combatTimers = naturalChange.timers;

    // After poison and prayer depletion, so a Rapid Heal that went dark this tick no longer counts,
    // and never for a player something killed earlier this tick. Not a hit: it writes HP directly,
    // so it cannot proc Redemption or show a hitsplat.
    if (player.alive && player.vitals.hp > 0) {
      const regen = tickNaturalHitpoints(
        player.vitals.hp,
        player.vitals.maxHp,
        player.combatTimers.hpRegenTick,
        nextTick,
        player.independentPrayers.includes(PrayerType.RapidHeal),
      );
      player.vitals.hp = regen.hp;
      player.combatTimers = { ...player.combatTimers, hpRegenTick: regen.regenTick };
    }

    // Closes the timer band: the combat formulas below read `player.stats`, so
    // every timer that moved a stat must be folded in before them.
    this.syncVitalsToStats();
  }

  private pausePlayerAutoAttack(targetId: ActorId, resumeTick: number): void {
    const player = this.player();
    const current = player.autoAttackPause;
    player.autoAttackPause = {
      targetId,
      resumeTick: current?.targetId === targetId ? Math.max(current.resumeTick, resumeTick) : resumeTick,
    };
  }

  private onCombatDamageApplied(info: DamageAppliedInfo): void {
    const player = this.player();
    const source =
      info.sourceId === PLAYER_ACTOR_ID ? 'PlayerAttack' : this.encounter.getNpcDamageSourceLabel(info.sourceId);
    const targetNpc = this.worldState.getNpcs().find((npc) => npc.id === info.targetId);

    const expectedHit = info.sourceId === PLAYER_ACTOR_ID ? info.expectedHit : undefined;
    if (info.sourceId === PLAYER_ACTOR_ID) {
      if (targetNpc) {
        this.encounter.onPlayerAttackResolved?.(
          {
            tick: info.tick,
            sourceId: info.sourceId,
            targetId: info.targetId,
            attackType: info.attackType,
            baseDamage: info.baseDamage,
            effectiveDamage: info.effectiveDamage,
            hpBefore: info.hpBefore,
            hpAfter: info.hpAfter,
          },
          {
            world: this.worldState,
            tickEvents: this.tickEvents,
            spawnNpc: (actor) => this.spawnEncounterNpc(actor),
            despawnNpc: (npcId) => this.despawnEncounterNpc(npcId),
            pausePlayerAutoAttack: (targetId, resumeTick): void => {
              this.pausePlayerAutoAttack(targetId, resumeTick);
            },
          },
        );
      }
    }
    if (targetNpc) this.npcDefinitions.notifyDamageResolved(targetNpc, info, this.buildNpcDefinitionContext());

    this.damageHistory.push({
      tick: info.tick,
      source,
      // From the instance that launched the hit: its source may since have been pruned, or its id reused.
      sourceNpcTypeId: info.sourceNpcTypeId,
      targetId: info.targetId,
      baseDamage: info.baseDamage,
      attackType: info.attackType,
      activePrayer: info.activePrayer,
      prayedCorrectly: info.prayedCorrectly,
      effectiveDamage: info.effectiveDamage,
      hpBefore: info.hpBefore,
      hpAfter: info.hpAfter,
      expectedHit,
    });

    this.logEvent({
      tick: info.tick,
      type: EventType.DAMAGE_TAKEN,
      source,
      attackType: info.attackType,
      baseDamage: info.baseDamage,
      effectiveDamage: info.effectiveDamage,
      prayedCorrectly: info.prayedCorrectly,
      hpAfter: info.hpAfter,
    });

    if (!this.mechanicsConfig.infiniteHealth && player.vitals.hp <= 0) {
      player.alive = false;
      this.failedCondition = 'Death';
      this.logEvent({
        tick: info.tick,
        type: EventType.DEATH,
        cause: source,
      });
    }

    // Every kill reward below belongs to the killing blow alone. An overkill hit landing after it (a
    // later multi-hit splat, a projectile already in flight) arrives at 0 HP and repeats none of them.
    const killingBlow = info.hpBefore > 0 && info.hpAfter === 0;
    if (info.onKillEffect && killingBlow && info.sourceId === PLAYER_ACTOR_ID) {
      this.applySpecOnKillEffect(player, info.onKillEffect, info.tick);
      if (targetNpc) this.emitSpecOnKillGraphic(targetNpc, info.onKillEffect);
    }

    // Death Charge pays out on ANY killing blow the player lands, not just a weapon special's —
    // at Yama that is overwhelmingly a void flare rather than the boss.
    if (targetNpc && killingBlow && info.sourceId === PLAYER_ACTOR_ID) {
      const charged = consumeDeathCharge(player.specialAttack, player.combatTimers);
      if (charged) {
        player.specialAttack = charged.special;
        player.combatTimers = charged.timers;
        this.tickEvents.emit({ type: 'death_charge_proc' });
      }
    }

    if (targetNpc && killingBlow) {
      // The combat system recorded the death at the lethal transition. Rewards and the defeat stay
      // anchored to K; an immediate death is processed now, a queued one at its `processTick`.
      if (targetNpc.death?.killTick !== info.tick) {
        throw new Error(`NPC '${targetNpc.id}' reached 0 HP without its lethal transition being recorded`);
      }
      targetNpc.despawnTick ??= info.tick;
      if (isNpcDeathDue(targetNpc, info.tick)) this.startNpcDeath(targetNpc);
      this.pendingNpcDefeats.push({ actor: targetNpc, defeat: { npcId: targetNpc.id, tick: info.tick } });
    }

    if (info.targetId === PLAYER_ACTOR_ID) {
      // Redemption resolves here, after the death check above: it cannot save a lethal hit, and it
      // must see the hit that was just applied. Every combat hit is eligible, including 0-damage.
      this.tryRedemption(info.tick);
      if (typeof info.applyPoison === 'number') {
        this.applyPoisonToPlayer(info.applyPoison);
      }
      this.notifyEncounterPlayerDamageTaken({
        sourceKind: 'combat',
        source,
        tick: info.tick,
        attackType: info.attackType,
        baseDamage: info.baseDamage,
        effectiveDamage: info.effectiveDamage,
        prayedCorrectly: info.prayedCorrectly,
        hpBefore: info.hpBefore,
        hpAfter: info.hpAfter,
        ...(info.sourceNpcTypeId === undefined ? {} : { sourceNpcTypeId: info.sourceNpcTypeId }),
      });
    }

    this.syncVitalsToStats();
  }

  private adjudicateNpcDefeats(ctx: EncounterContext): void {
    const defeats = this.pendingNpcDefeats;
    this.pendingNpcDefeats = [];
    if (!this.player().alive || this.failedCondition !== null) return;
    for (const { actor, defeat } of defeats) {
      this.encounter.onNpcDefeated?.(defeat, ctx, this.completionOwnership);
      this.npcDefinitions.notifyDefeated(actor, defeat, this.completionOwnership, this.buildNpcDefinitionContext());
    }
  }

  private emitSpecOnKillGraphic(target: NpcActor, effect: OnKillEffect): void {
    const variants = effect.targetGraphicBySize;
    if (!variants || variants.length === 0) return;
    const spotAnimId = variants[Math.min(Math.max(1, target.size), variants.length) - 1];
    this.tickEvents.emit({ type: 'npc_graphic_applied', targetId: target.id, spotAnimId, height: 0 });
  }

  private applySpecOnKillEffect(player: PlayerActor, effect: OnKillEffect, tick: number): void {
    if (effect.refundSpecEnergy) {
      const SPECIAL_ATTACK_MAX_ENERGY = 100;
      player.specialAttack = {
        ...player.specialAttack,
        energy: Math.min(SPECIAL_ATTACK_MAX_ENERGY, player.specialAttack.energy + effect.refundSpecEnergy),
      };
    }
    if (effect.reduceAttackDelayTicks) {
      this.combatSystem.reduceNextAttackTick(player.id, effect.reduceAttackDelayTicks, tick);
    }
  }

  /**
   * OSRS 2048-unit angle from movement delta.
   * 0=south, 512=west, 1024=north, 1536=east.
   */
  private calculateAngleFromDelta(dx: number, dy: number, currentFacing: number): number {
    if (dx === 0 && dy === 0) return currentFacing;

    if (dx === 0) {
      if (dy > 0) return 1024;
      if (dy < 0) return 0;
    } else if (dx > 0) {
      if (dy > 0) return 1280;
      if (dy < 0) return 1792;
      return 1536;
    } else {
      if (dy > 0) return 768;
      if (dy < 0) return 256;
      return 512;
    }
    return currentFacing;
  }

  private faceStationaryNpcTarget(npc: NpcActor): void {
    if (npc.isMoving === true) return;
    // A locked-facing NPC (e.g. Zuk's shield always faces south) must never be
    // auto-turned toward its target, even when it has one.
    if (npc.lockedFacing !== undefined) return;
    const targetId = npc.combat.targetId;
    if (targetId === null) return;
    const target = this.worldState.actors.get(targetId);
    if (!target?.alive) return;
    npc.facing = this.calculateAngleTowardActor(npc, target);
  }

  private calculateAngleTowardActor(npc: NpcActor, target: ActorBase): number {
    const targetCenterX = target.position[0] + (target.size - 1) / 2;
    const targetCenterY = target.position[1] + (target.size - 1) / 2;
    const npcMaxX = npc.position[0] + npc.size - 1;
    const npcMaxY = npc.position[1] + npc.size - 1;
    const closestNpcX = Math.max(npc.position[0], Math.min(targetCenterX, npcMaxX));
    const closestNpcY = Math.max(npc.position[1], Math.min(targetCenterY, npcMaxY));

    return this.calculateAngleFromDelta(targetCenterX - closestNpcX, targetCenterY - closestNpcY, npc.facing);
  }

  private getEncounterMechanics(): MechanicsConfig {
    return { ...this.mechanicsConfig };
  }

  public setCtrlClickOverride(override: boolean): void {
    this.player().ctrlClickOverride = override;
  }

  /**
   * Whether the player can cast a self-cast Arceuus spell right now: the spellbook it lives on,
   * its Magic level, and its rune types — the same gate that grays the icon in the spellbook.
   *
   * The engine has to own it rather than trusting the panel. A cast arrives here from a replay,
   * from the tutorial director and from a context menu as well as from a click on an enabled
   * icon, and none of those consult the panel's graying.
   */
  private canCastSelfSpell(spellName: string): boolean {
    const player = this.player();
    // Both spells are Arceuus. Swapping spellbook mid-fight takes the whole book away, and the
    // panel stops drawing them — but nothing outside the panel would notice on its own.
    if (player.combatSupplies.spellbook !== 'arceuus') return false;
    return canCastSpell(spellName, {
      equipment: player.equipment,
      inventory: player.inventory,
      runePouch: player.combatSupplies.runePouch ?? null,
      // Boosted, not base: casting is gated on the current Magic level, so a Magic potion or a
      // saturated heart genuinely unlocks Death Charge at 79 base.
      magicLevel: player.stats.magic.current,
    });
  }

  public castMarkOfDarkness(): void {
    const player = this.player();
    if (!this.canCastSelfSpell(MARK_OF_DARKNESS_SPELL)) {
      return;
    }
    const hasPurgingStaff = player.equipment.weapon === PURGING_STAFF_ITEM_ID;
    const nextTimers = castMarkOfDarknessTimer(player.stats.magic.max, hasPurgingStaff, player.combatTimers);
    if (!nextTimers) {
      return;
    }

    player.combatTimers = nextTimers;
    this.tickEvents.emit({
      type: 'spell_self_cast',
      animationId: SELF_IMBUE_CAST_ANIM_ID,
      spotAnimId: MARK_OF_DARKNESS_SPOTANIM_ID,
    });
  }

  /**
   * Cast Death Charge. Silently does nothing while on cooldown, matching
   * {@link castMarkOfDarkness}.
   *
   * `doubleDeathCharge` is the rite of vile transference, a permanent account unlock rather than
   * anything carried into the fight, so it reads off a mechanics toggle. The upgraded cast has its
   * own spotanim (3288, `death_charge_upgrade_cast_spotanim` — the one in the sensory capture at
   * t8905).
   */
  public castDeathCharge(): void {
    const player = this.player();
    if (!this.canCastSelfSpell(DEATH_CHARGE_SPELL)) {
      return;
    }
    const upgraded = this.mechanicsConfig.doubleDeathCharge === true;
    const nextTimers = castDeathChargeTimer(player.combatTimers, upgraded);
    if (!nextTimers) {
      return;
    }

    player.combatTimers = nextTimers;
    this.tickEvents.emit({
      type: 'spell_self_cast',
      animationId: SELF_IMBUE_CAST_ANIM_ID,
      spotAnimId: upgraded ? DEATH_CHARGE_UPGRADE_SPOTANIM_ID : DEATH_CHARGE_SPOTANIM_ID,
    });
  }

  public triggerHomeTeleport(): void {
    this.tickEvents.emit({
      type: 'spell_self_cast',
      animationId: 714,
      spotAnimId: 111,
    });
    this.lastTickEvents = this.tickEvents.flush();
  }

  public applyAction(action: EngineAction): void {
    this.replayTakeoverWork?.recordAction();
    switch (action.type) {
      case 'protectionPrayer':
        this.queueProtectionPrayer(action.prayer);
        break;
      case 'offensivePrayer':
        this.queueBoostPrayer(action.prayer);
        break;
      case 'independentPrayer':
        this.queueIndependentPrayer(action.prayer);
        break;
      case 'equipFromInventory':
        this.queueEquipFromInventory(action.inventoryIndex, action.itemId, action.slot);
        break;
      case 'equipAmmoFromInventory':
        this.queueEquipAmmoFromInventory(action.inventoryIndex, action.itemId);
        break;
      case 'unequipAmmo':
        this.queueUnequipAmmo();
        break;
      case 'itemAction':
        this.queueItemAction(action.inventoryIndex, action.option);
        break;
      case 'unequip':
        this.queueUnequip(action.slot);
        break;
      case 'specialAttackToggle':
        this.queueSpecialAttackToggle();
        break;
      case 'runToggle':
        this.queueRunToggle();
        break;
      case 'quickPrayerToggle':
        this.queueQuickPrayerToggle(action.selections);
        break;
      case 'castMarkOfDarkness':
        this.castMarkOfDarkness();
        break;
      case 'castDeathCharge':
        this.castDeathCharge();
        break;
      case 'ctrlClick':
        this.setCtrlClickOverride(action.ctrlKey);
        break;
      case 'swapInventory':
        this.swapInventorySlots(action.from, action.to);
        break;
      case 'attackTarget':
        this.queueAttackTarget(action.targetId);
        break;
      case 'manualCast':
        this.queueAttackTarget(action.targetId, action.spellName);
        break;
      case 'npcInteraction':
        this.queueInput({ type: 'npc_interaction', targetId: action.targetId });
        break;
      case 'equipmentSlotClick':
        this.queueEquipmentSlotClick(action.slot);
        break;
      case 'attackStyleChange':
        this.setSelectedAttackStyleIndex(action.index);
        break;
      case 'selectedSpellChange':
        this.setSelectedSpell(action.spellName);
        break;
      case 'setBossHp':
        this.setBossHp(action.hp);
        break;
      case 'applyBossHpPreset':
        this.applyBossHpPreset(action.hp);
        break;
      case 'dropItem':
        this.queueDropItem(action.inventoryIndex);
        break;
      case 'pickupGroundItem':
        this.queuePickupGroundItem(action.groundItemId);
        break;
      case 'encounterCommand':
        this.queueEncounterCommand(action.command);
        break;
      default: {
        const _exhaustive: never = action;
        void _exhaustive;
      }
    }
  }

  public setObjTypeLoader(loader: ObjTypeLoader | null): void {
    this.objTypeLoader = loader;
    this.recalculateEquipmentStats();
  }

  public setEquipment(equipment: PlayerEquipment): void {
    const player = this.player();
    const prevWeapon = player.equipment.weapon;
    player.equipment = equipment;
    this.recalculateEquipmentStats();
    if (equipment.weapon !== prevWeapon) {
      player.isSpecialAttackActive = false;
      this.syncAttackStyleForCurrentWeapon();
    }
  }

  private queueInput(op: PendingInputOp): void {
    this.player().pendingInputOps.push(op);
  }

  public queueUnequip(slot: keyof PlayerEquipment): void {
    this.queueInput({ type: 'unequip', slot });
  }

  public queueEquipFromInventory(inventoryIndex: number, itemId: number, slot: keyof PlayerEquipment): void {
    this.queueInput({ type: 'equip', inventoryIndex, itemId, slot });
  }

  public queueEquipAmmoFromInventory(inventoryIndex: number, itemId: number): void {
    this.queueInput({ type: 'equip_ammo', inventoryIndex, itemId });
  }

  public queueUnequipAmmo(): void {
    this.queueInput({ type: 'unequip_ammo' });
  }

  public queueItemAction(inventoryIndex: number, option: ItemActionOption = 'default'): void {
    this.queueInput({ type: 'use_item', inventoryIndex, option });
  }

  /**
   * Queue a "Drop". Unlike eat/drink/equip this does NOT cancel the attack
   * interaction: dropping vials or bones mid-fight is routine in game and does not
   * stop the player attacking.
   */
  public queueDropItem(inventoryIndex: number): void {
    this.queueInput({ type: 'drop_item', inventoryIndex });
  }

  /**
   * Queue a "Take". The interaction persists across ticks while the player walks
   * onto the tile; {@link processItemPickup} resolves it before each tick's movement.
   */
  public queuePickupGroundItem(groundItemId: string): void {
    this.queueInput({ type: 'pickup_ground_item', groundItemId });
  }

  public queueSpecialAttackToggle(): void {
    this.queueInput({ type: 'special_attack_toggle' });
  }

  public getPendingSpecialAttackToggles(): number {
    return this.player().pendingInputOps.filter((op) => op.type === 'special_attack_toggle').length;
  }

  public projectSpecialAttackState(additionalOps: readonly PendingInputOp[] = []): boolean {
    const player = this.player();
    let active = player.isSpecialAttackActive;
    let loadout: EquipmentInputState = {
      inventory: player.inventory,
      equipment: player.equipment,
      combatSupplies: player.combatSupplies,
    };
    let itemState = this.getItemActionState(this.worldState.tick + 1);
    let tracklessItemUsed = false;
    for (const ops of [player.pendingInputOps, additionalOps]) {
      for (const op of ops) {
        switch (op.type) {
          case 'equip':
          case 'unequip':
          case 'equip_ammo':
          case 'unequip_ammo': {
            const next = this.previewEquipmentOp(loadout, op);
            if (next) {
              if (next.equipment.weapon !== loadout.equipment.weapon) active = false;
              loadout = next;
            }
            break;
          }
          case 'special_attack_toggle': {
            const projectedPlayer = { ...player, ...loadout, specialAttack: itemState.specialAttack };
            const activation = resolveInstantSpecialActivation(
              loadout.equipment.weapon,
              itemState.specialAttack,
              resolveDynamic(this.encounter.getEngineRules?.()?.specialAttacks?.energyCostMultiplier, {
                tick: itemState.currentTick,
                player: projectedPlayer,
                world: this.worldState,
              }) ?? 1,
            );
            if (activation !== null) {
              active = false;
              itemState = { ...itemState, specialAttack: activation.specialAttack };
              break;
            }
            if (loadout.equipment.weapon !== undefined && hasSpecialAttack(loadout.equipment.weapon)) {
              active = !active;
            }
            break;
          }
          case 'drop_item':
            loadout = { ...loadout, inventory: removeInventorySlot(loadout.inventory, op.inventoryIndex) };
            break;
          case 'use_item': {
            const item = loadout.inventory[op.inventoryIndex];
            if (!item) break;
            const def = getItemAction(item.id, op.option);
            if (!def) break;
            const { track, delayTicks } = def;
            if (track === undefined && tracklessItemUsed) break;
            if (def.minHpToUse !== undefined && itemState.playerHP < def.minHpToUse) break;
            if (
              track !== undefined &&
              delayTicks > 0 &&
              !canUseAction(itemState.cooldownTracks, track, itemState.currentTick)
            )
              break;
            if (isItemActionRefused(def.effects, itemState)) break;
            itemState = this.resolveItemEffects(def, itemState, loadout).newState;
            loadout = { ...loadout, inventory: this.consumeInventoryItem(loadout.inventory, op.inventoryIndex, def) };
            if (track !== undefined && delayTicks > 0) {
              itemState = {
                ...itemState,
                cooldownTracks: applyCooldown(itemState.cooldownTracks, track, itemState.currentTick, delayTicks),
              };
            }
            tracklessItemUsed ||= track === undefined;
            break;
          }
          case 'protection':
          case 'boost':
          case 'independent':
          case 'quickPrayers':
          case 'run_toggle':
          case 'attack_target':
          case 'npc_interaction':
          case 'pickup_ground_item':
            break;
          default: {
            const exhaustive: never = op;
            void exhaustive;
          }
        }
      }
    }
    return active;
  }

  /**
   * This encounter's restat of one NPC, if any.
   */
  public getMonsterStatOverride(npcTypeId: number | undefined): MonsterStatOverride | undefined {
    if (npcTypeId === undefined) return undefined;
    return this.getEncounterRules()?.monsterStatOverrides?.[npcTypeId];
  }

  public getAdjustedTheoreticalDps(): FirstPartyPlayerAttackProjectionSummary | null {
    const player = this.player();
    // As the HUD reads it: the remembered target outlasts a manual cast's ended interaction.
    const targetId = player.attackTarget ?? player.lastAttackTarget;
    const target = targetId
      ? (this.worldState.getNpcs().find((npc) => npc.id === targetId) ??
        this.worldState.getNpcs().find((npc) => npc.role === 'boss'))
      : this.worldState.getNpcs().find((npc) => npc.role === 'boss');

    if (!target || target.vitals.hp <= 0) {
      return null;
    }

    const combatParams = this.getPlayerCombatParams(player);
    const formulaStyle = getFormulaStyle(player.equipment.weapon, player.selectedAttackStyleIndex);
    const activeSpell = resolveActiveSpell({
      weaponId: player.equipment.weapon,
      selectedStyleIndex: player.selectedAttackStyleIndex,
      selectedSpell: player.combatSupplies.selectedSpell,
      spellbook: player.combatSupplies.spellbook,
    });
    const resources = resolveAttackResources({
      weaponId: player.equipment.weapon,
      equipment: player.equipment,
      inventory: player.inventory,
      formulaStyle,
      supplies: player.combatSupplies,
      magicLevel: player.stats.magic.current,
      activeSpell: activeSpell?.name ?? null,
    });
    const engineContext = this.buildEngineContext();
    const encounterRules = this.getEncounterRules();
    const outgoingDamageMultiplier = resolveDynamic(encounterRules?.outgoingDamageMultiplier, engineContext) ?? 1;
    const standardAccuracyMode = isConflictionAttackEligible({
      equipment: player.equipment,
      formulaStyle,
      attackResources: resources,
    })
      ? 'steady_state'
      : 'single_roll';

    return projectFirstPartyPlayerAttack({
      player,
      target,
      formulaStyle,
      resources,
      attackSpeedTicks: combatParams.attackSpeed,
      delivery: {
        style: formulaStyleToDamageType(formulaStyle),
        attackKind: formulaStyleToAttackKind(formulaStyle),
        impactDelayTicks: 0,
      },
      application: { outgoingDamageMultiplier, specialAttackDamageMultiplier: 1 },
      manualCast: false,
      isSpecialAttack: false,
      standardAccuracyMode,
      ...(encounterRules === undefined ? {} : { encounterRules }),
      encounterContext: engineContext,
      lookupItemStats: (itemId): EquipmentStats | null => this.lookupItemStats(itemId),
      targetDistance: chebyshevDistanceToRect(
        player.position[0],
        player.position[1],
        target.position[0],
        target.position[1],
        target.size,
      ),
    });
  }

  public setAttackTarget(targetId: ActorId | null): void {
    const player = this.player();
    player.pendingNpcInteraction = undefined;
    registerPlayerAttackIntent(player, this.worldState, { targetId, manualCastSpell: null });
  }

  private queueAttackTarget(targetId: ActorId | null, manualCastSpell: string | null = null): void {
    this.queueInput({ type: 'attack_target', targetId, manualCastSpell });
  }

  /**
   * Whether the active encounter consumes this interaction. Pure query — nothing is queued.
   *
   * Callers gate on this and then dispatch through their normal input path, so the click is
   * still recorded for replay and still honors input lag.
   */
  public acceptsEncounterInput(input: EncounterInput): boolean {
    return this.encounter.acceptsInput?.(input, this.buildEngineContext()) ?? false;
  }

  private getNpcInteractionTarget(player: PlayerActor): NpcActor | null {
    const targetId = player.pendingNpcInteraction;
    if (targetId === undefined) return null;
    const target = this.worldState.getNpc(targetId);
    if (player.alive && target?.alive && this.acceptsEncounterInput({ kind: 'npcInteraction', targetId })) {
      return target;
    }
    player.pendingNpcInteraction = undefined;
    return null;
  }

  public queueEquipmentSlotClick(slot: EquipmentClickSlot): void {
    this.pendingEquipmentSlotClicks.push(slot);
  }

  private forceSetProtectionPrayer(prayer: PrayerType | null): void {
    if (prayer === null) {
      this.removeProtectionPrayer(this.worldState.tick);
      return;
    }
    const player = this.player();
    if (player.activePrayer === prayer) {
      return;
    }
    const previousPrayer = player.activePrayer;
    player.activePrayer = prayer;
    this.enforceQuickPrayerInvariant();
    this.rebuildActivePrayers();
    this.tickEvents.emit({ type: 'prayer_changed', actorId: player.id, from: previousPrayer, to: prayer });
  }

  public getAttackTarget(): ActorId | null {
    return this.player().attackTarget;
  }

  public setSelectedAttackStyleIndex(index: number): void {
    const player = this.player();
    player.selectedAttackStyleIndex = index;
    const categoryKey = getWeaponCategoryKey(player.equipment.weapon);
    this._attackStylePerCategory[categoryKey] = index;
  }

  public setAttackStylePerCategory(map: Record<string, number>): void {
    this._attackStylePerCategory = { ...map };
    this.syncAttackStyleForCurrentWeapon();
  }

  public getAttackStylePerCategory(): Record<string, number> {
    return this._attackStylePerCategory;
  }

  private syncAttackStyleForCurrentWeapon(): void {
    const player = this.player();
    const categoryKey = getWeaponCategoryKey(player.equipment.weapon);
    const rememberedIndex = this._attackStylePerCategory[categoryKey];
    player.selectedAttackStyleIndex =
      rememberedIndex !== undefined && getWeaponCategory(player.equipment.weapon).styles[rememberedIndex] !== undefined
        ? rememberedIndex
        : getDefaultAttackStyleIndex(player.equipment.weapon, player.combatSupplies.spellbook);
  }

  private isTwoHanded(itemId: number): boolean {
    if (!this.objTypeLoader) return false;
    try {
      const obj = this.objTypeLoader.load(itemId);
      return obj.wearPos2 === 5;
    } catch {
      return false;
    }
  }

  private countEmptySlotsInInventory(inventory: Inventory, excludeIndex?: number): number {
    let count = 0;
    for (let i = 0; i < inventory.length; i++) {
      if (inventory[i] === null || i === excludeIndex) count += 1;
    }
    return count;
  }

  /**
   * BAND 2 — drain this tick's client ops as one FIFO.
   *
   * Ops are applied in the order they were clicked and each sees the state every
   * earlier op wrote, which is the whole of what a real server does with a tick's
   * packets (rsmod `PlayerInputProcess`).
   * Nothing here may re-group by op type: doing so decides same-tick races by
   * phase order, which is how a restore dose stopped enabling a prayer clicked
   * after it.
   */
  private processInputBand(tick: number): void {
    const player = this.player();
    this.enforcePrayerRestrictions(tick);

    const ops = player.pendingInputOps;
    if (ops.length === 0) return;
    player.pendingInputOps = [];

    // The replay log records the NET slot change for the tick, while tickEvents
    // carry every individual op. An off→on flick inside one tick is two ops and
    // two sounds, but nothing a replay has to reproduce.
    const protectionBefore = player.activePrayer;
    const boostBefore = player.boostPrayers;
    const independentBefore = player.independentPrayers;

    // An attack op earlier in this same tick outranks the interaction cancel an
    // eat/equip/drink op would otherwise apply: the target survives (movement
    // continues, "drag to melee") while the attack itself is called off.
    let attackOpSeen = false;
    // A trackless item (locator orb, rock cake) takes no cooldown, so nothing else stops a
    // second click landing on the same tick. One inventory option goes through per tick: the
    // capture shows nine orb uses, never two on one tick, but on CONSECUTIVE ticks.
    let tracklessItemUsed = false;
    // One rejection sound per tick, however many activations were refused.
    let prayerRejectionEmitted = false;

    for (const op of ops) {
      switch (op.type) {
        case 'protection':
        case 'boost':
        case 'independent':
        case 'quickPrayers':
          prayerRejectionEmitted = this.applyPrayerOp(op, tick, prayerRejectionEmitted);
          break;
        case 'unequip':
        case 'equip':
        case 'equip_ammo':
        case 'unequip_ammo':
          this.applyEquipmentOp(op, attackOpSeen);
          break;
        case 'use_item':
          tracklessItemUsed = this.applyItemOp(op, attackOpSeen, tracklessItemUsed);
          break;
        case 'drop_item':
          this.applyDropOp(op, tick);
          break;
        case 'special_attack_toggle':
          if (
            activateInstantSpecial(
              player,
              tick,
              resolveDynamic(this.encounter.getEngineRules?.()?.specialAttacks?.energyCostMultiplier, {
                tick,
                player,
                world: this.worldState,
              }) ?? 1,
            )
          )
            break;
          if (player.equipment.weapon !== undefined && hasSpecialAttack(player.equipment.weapon)) {
            player.isSpecialAttackActive = !player.isSpecialAttackActive;
          }
          break;
        case 'run_toggle':
          // Any run-orb interaction drops a ctrl-click walk override, even when a
          // second click in the same tick puts run mode back where it started.
          player.ctrlClickOverride = false;
          player.isRunEnabled = !player.isRunEnabled;
          break;
        case 'attack_target':
          registerPlayerAttackIntent(player, this.worldState, op);
          // A new walk/attack click replaces whatever the player was walking to take.
          player.pendingItemPickup = null;
          player.pendingNpcInteraction = undefined;
          attackOpSeen = true;
          break;
        case 'npc_interaction':
          if (this.acceptsEncounterInput({ kind: 'npcInteraction', targetId: op.targetId })) {
            clearPlayerAttackIntent(player);
            player.pendingItemPickup = null;
            player.pendingNpcInteraction = op.targetId;
          }
          break;
        case 'pickup_ground_item':
          player.pendingNpcInteraction = undefined;
          player.pendingItemPickup = { groundItemId: op.groundItemId };
          break;
        default: {
          const exhaustive: never = op;
          void exhaustive;
        }
      }
    }

    if (player.activePrayer !== protectionBefore) {
      this.logEvent({ tick, type: EventType.PRAYER_CHANGE, from: protectionBefore, to: player.activePrayer });
    }
    for (const change of [
      ...prayerSetLogChanges(boostBefore, player.boostPrayers),
      ...prayerSetLogChanges(independentBefore, player.independentPrayers),
    ]) {
      this.logEvent({ tick, type: EventType.PRAYER_CHANGE, ...change });
    }
  }

  /**
   * Drop a protection prayer an encounter puts a timer on, at the END of the tick.
   *
   * The placement is the mechanic, not an implementation detail. Every source of damage
   * to the player resolves earlier in `advanceTick` (hazards, npc attacks, pending
   * projectile hits, post-tick), so a prayer expiring here has already covered this
   * tick's hits and only then goes dark. That is what the capture shows: under Divine
   * Severance the `prayer_protectfrom*` varbit flips to 0 on the same tick a hit reads
   * `value=0` (capture ticks 911 click / 912 off + blocked). Expiring at the TOP of a
   * tick instead would show the prayer up for a tick it no longer protects.
   *
   * So `expiresAfterTicks: n` means n ticks of protection, the last of which is also the
   * tick the player watches it switch off.
   */
  private expireTimedProtectionPrayer(tick: number): void {
    const protRestrict = this.getEncounterRules()?.prayerRestrictions?.protection;
    if (typeof protRestrict !== 'object' || !('expiresAfterTicks' in protRestrict)) return;

    const player = this.player();
    if (player.activePrayer === null || this.protectionPrayerActivatedTick === null) return;
    // `- 1` because the activation tick is the first protected one. Clamped so a
    // nonsensical 0 expires immediately rather than silently never expiring.
    const ticksBeforeExpiry = Math.max(0, protRestrict.expiresAfterTicks - 1);
    if (tick - this.protectionPrayerActivatedTick < ticksBeforeExpiry) return;

    this.removeProtectionPrayer(tick);
  }

  /**
   * The engine's single non-click path for taking the protection prayer down: expiry, encounter
   * blocks, disabling hits, and encounter/NPC callbacks all land here so their bookkeeping cannot
   * drift. Lockout durations and timing stay with the callers.
   */
  private removeProtectionPrayer(tick: number): void {
    const player = this.player();
    const previousPrayer = player.activePrayer;
    if (previousPrayer === null) return;
    player.activePrayer = null;
    // A later reactivation starts a fresh `expiresAfterTicks` window.
    this.protectionPrayerActivatedTick = null;
    this.enforceQuickPrayerInvariant();
    // Without this the prayer stays in `prayerState.activePrayers` and keeps draining
    // points after it has stopped protecting — `tickPrayerDrain` reads that list, not
    // `activePrayer`.
    this.rebuildActivePrayers();
    this.logEvent({ tick, type: EventType.PRAYER_CHANGE, from: previousPrayer, to: null });
    this.tickEvents.setTick(tick);
    this.tickEvents.emit({ type: 'prayer_changed', actorId: player.id, from: previousPrayer, to: null });
  }

  /** Force off any prayer the encounter blocks outright, before this tick's ops run. */
  private enforcePrayerRestrictions(tick: number): void {
    const rules = this.getEncounterRules();
    if (rules?.prayerRestrictions?.protection === 'blocked') this.removeProtectionPrayer(tick);
    if (rules?.prayerRestrictions?.offensive === 'blocked') this.removeBoostPrayers(tick, () => true);
    this.enforceQuickPrayerInvariant();
  }

  /** The non-click path for taking boost prayers down. See {@link removeProtectionPrayer}. */
  private removeBoostPrayers(tick: number, shouldRemove: (prayer: PrayerType) => boolean): void {
    const player = this.player();
    const removed = player.boostPrayers.filter(shouldRemove);
    if (removed.length === 0) return;
    player.boostPrayers = player.boostPrayers.filter((prayer) => !removed.includes(prayer));
    this.enforceQuickPrayerInvariant();
    this.rebuildActivePrayers();
    this.tickEvents.setTick(tick);
    for (const prayer of removed) {
      this.logEvent({ tick, type: EventType.PRAYER_CHANGE, from: prayer, to: null });
      this.tickEvents.emit({ type: 'prayer_changed', actorId: player.id, from: prayer, to: null });
    }
  }

  /**
   * Apply ONE prayer-book or quick-prayer click against live state.
   *
   * Resolved one op at a time because the activation guard can observe prayer points restored by
   * an earlier op in the same tick (RSMod `PrayerTabScript.enablePrayer`).
   *
   * Returns the updated "a rejection was already announced this tick" flag.
   */
  private applyPrayerOp(op: QueuedPrayerAction, tick: number, rejectionEmitted: boolean): boolean {
    // The book never offers a locked upgrade prayer, so an op naming one is dropped, not refused.
    const unlocked = (prayer: PrayerType): boolean => isPrayerUnlocked(prayer, this.mechanicsConfig);
    if (op.type !== 'quickPrayers' && op.prayer !== null && !unlocked(op.prayer)) return rejectionEmitted;
    const action = op.type === 'quickPrayers' ? { ...op, selections: op.selections.filter(unlocked) } : op;
    const player = this.player();
    const rules = this.getEncounterRules();
    const protRestrict = rules?.prayerRestrictions?.protection;
    const offRestrict = rules?.prayerRestrictions?.offensive;

    const outcome = resolvePrayerActions(
      {
        protection: player.activePrayer,
        boost: player.boostPrayers,
        independent: player.independentPrayers,
        quickPrayersActive: player.quickPrayersActive,
      },
      [action],
      player.prayerState.points > 0,
    );
    player.quickPrayersActive = outcome.quickPrayersActive;

    // A disabling hit refuses protection prayers for a few ticks; the attempt is a failed activation.
    const protectionLocked = tick < this.protectionPrayersDisabledUntilTick;
    const lockedAttempt =
      protectionLocked && outcome.protection !== null && outcome.activated.includes(outcome.protection)
        ? outcome.protection
        : null;
    const protectionBlocked = protRestrict === 'blocked' || protectionLocked;
    const rejected = outcome.rejected[0] ?? lockedAttempt;

    let nextRejectionEmitted = rejectionEmitted;
    if (rejected !== null && rejected !== undefined && !rejectionEmitted) {
      this.tickEvents.setTick(tick);
      this.tickEvents.emit({
        type: 'prayer_activation_failed',
        actorId: player.id,
        attemptedPrayer: rejected,
      });
      nextRejectionEmitted = true;
    }
    // The server's reply to a refused click under the lockout (L:5150; also ToB, Vardorvis, Yama).
    if (lockedAttempt !== null && outcome.rejected.length === 0) {
      this.tickEvents.setTick(tick);
      this.tickEvents.emit({ type: 'game_message', kind: 'game', segments: PRAYER_LOCKOUT_MESSAGE });
    }

    const nextProtection = protectionBlocked ? null : outcome.protection;
    const nextBoost = offRestrict === 'blocked' ? [] : outcome.boost;

    for (const transition of outcome.transitions) {
      if (
        (transition.slot === 'protection' && protectionBlocked) ||
        (transition.slot === 'boost' && offRestrict === 'blocked')
      ) {
        continue;
      }
      this.tickEvents.setTick(tick);
      this.tickEvents.emit({
        type: 'prayer_changed',
        actorId: player.id,
        from: transition.from,
        to: transition.to,
      });
      if (transition.from === PrayerType.RapidHeal || transition.to === PrayerType.RapidHeal) {
        this.restartHpRegen(tick, transition.to === PrayerType.RapidHeal);
      }
    }

    // Drain grace period (OSRS: a prayer does not drain on the tick it was
    // activated). Only a real inactive→active transition earns it, so a genuine
    // off→on flick keeps prayer free while rejected or no-op inputs do not.
    const activated = outcome.activated.filter(
      (prayer) => prayer === nextProtection || nextBoost.includes(prayer) || outcome.independent.includes(prayer),
    );
    if (activated.length > 0) {
      const prayerActivationTicks = { ...player.prayerState.prayerActivationTicks };
      for (const prayer of activated) {
        prayerActivationTicks[prayer] = tick;
      }
      player.prayerState = { ...player.prayerState, prayerActivationTicks };
    }

    if (
      nextProtection !== null &&
      outcome.activated.includes(nextProtection) &&
      typeof protRestrict === 'object' &&
      'expiresAfterTicks' in protRestrict
    ) {
      this.protectionPrayerActivatedTick = tick;
    }

    let changed = false;
    if (outcome.protectionTouched && player.activePrayer !== nextProtection) {
      player.activePrayer = nextProtection;
      changed = true;
    }

    if (outcome.boostTouched && !samePrayers(player.boostPrayers, nextBoost)) {
      player.boostPrayers = [...nextBoost];
      changed = true;
    }

    if (outcome.independentTouched && !samePrayers(player.independentPrayers, outcome.independent)) {
      player.independentPrayers = [...outcome.independent];
      changed = true;
    }

    this.enforceQuickPrayerInvariant();
    if (changed) this.rebuildActivePrayers();

    return nextRejectionEmitted;
  }

  private previewEquipmentOp(state: EquipmentInputState, action: QueuedEquipmentAction): EquipmentInputState | null {
    switch (action.type) {
      case 'unequip': {
        const preview = this.previewUnequipState(state.inventory, state.equipment, action.slot);
        return preview ? { ...state, ...preview } : null;
      }
      case 'equip': {
        const inventoryIndex = this.resolveQueuedEquipInventoryIndex(
          state.inventory,
          action.inventoryIndex,
          action.itemId,
        );
        const preview = this.previewEquipFromInventoryState(
          state.inventory,
          state.equipment,
          inventoryIndex,
          action.slot,
        );
        return preview ? { ...state, ...preview } : null;
      }
      case 'equip_ammo': {
        const inventoryIndex = this.resolveQueuedEquipInventoryIndex(
          state.inventory,
          action.inventoryIndex,
          action.itemId,
        );
        const inventory = this.previewEquipAmmoFromInventory(state.inventory, state.combatSupplies, inventoryIndex);
        return inventory
          ? { ...state, inventory, combatSupplies: { ...state.combatSupplies, equippedAmmo: { id: action.itemId } } }
          : null;
      }
      case 'unequip_ammo': {
        const inventory = this.previewUnequipAmmo(state.inventory, state.combatSupplies);
        return inventory
          ? { ...state, inventory, combatSupplies: { ...state.combatSupplies, equippedAmmo: null } }
          : null;
      }
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  private applyEquipmentOp(action: QueuedEquipmentAction, attackOpSeen: boolean): void {
    const player = this.player();
    const prevWeapon = player.equipment.weapon;
    const preview = this.previewEquipmentOp(
      { inventory: player.inventory, equipment: player.equipment, combatSupplies: player.combatSupplies },
      action,
    );
    if (!preview) return;
    player.inventory = preview.inventory;
    player.equipment = preview.equipment;
    player.combatSupplies = preview.combatSupplies;
    if (action.type === 'equip') {
      this.tickEvents.emit({
        type: 'item_equipped',
        slot: action.slot,
        itemId: action.itemId,
        equipSound: this.getEquipSoundKind(action.slot, action.itemId),
      });
    }

    this.recalculateEquipmentStats();
    if (player.equipment.weapon !== prevWeapon) {
      player.isSpecialAttackActive = false;
      this.syncAttackStyleForCurrentWeapon();
    }
    if (action.type === 'equip' || action.type === 'equip_ammo') {
      // OSRS: an interface action clears the weak queue, canceling the attack.
      // A target clicked earlier in THIS tick outranks that: it keeps the target
      // (so movement continues) and only the interaction is called off.
      if (attackOpSeen) {
        player.attackInteractionActive = false;
      } else {
        player.attackTarget = null;
      }
    }
  }

  private resolveQueuedEquipInventoryIndex(inventory: Inventory, preferredIndex: number, itemId: number): number {
    if (inventory[preferredIndex]?.id === itemId) {
      return preferredIndex;
    }
    return inventory.findIndex((slot) => slot?.id === itemId);
  }

  private getEquipSoundKind(slot: keyof PlayerEquipment, itemId: number): EquipSoundKind {
    if (slot === 'head') return 'helmet';
    if (slot === 'legs') return 'legs';
    if (slot === 'hands') return 'hands';
    if (slot === 'body') return this.isMetalBodyItem(itemId) ? 'metal_body' : 'fun';
    if (slot === 'weapon') {
      const category = getWeaponCategoryKey(itemId);
      return category === 'staff' || category === 'powered_staff' ? 'staff' : 'fun';
    }
    return 'fun';
  }

  private isMetalBodyItem(itemId: number): boolean {
    if (!this.objTypeLoader) return false;

    try {
      const name = this.objTypeLoader.load(itemId).name.toLowerCase();
      if (NON_METAL_BODY_NAME_FRAGMENTS.some((fragment) => name.includes(fragment))) {
        return false;
      }
      return METAL_BODY_NAME_FRAGMENTS.some((fragment) => name.includes(fragment));
    } catch {
      return false;
    }
  }

  private getItemActionState(tick: number): ItemActionState {
    const player = this.player();
    return {
      playerHP: player.vitals.hp,
      maxHP: player.vitals.maxHp,
      stats: player.stats,
      poisonState: player.poisonState,
      prayerState: player.prayerState,
      runEnergy: player.runEnergy,
      specialAttack: player.specialAttack,
      combatTimers: player.combatTimers,
      cooldownTracks: player.cooldownTracks,
      activeEffects: player.activeEffects,
      currentTick: tick,
    };
  }

  private resolveItemEffects(
    def: ItemActionDef,
    state: ItemActionState,
    loadout: Pick<EquipmentInputState, 'equipment' | 'inventory'>,
  ) {
    const itemRules = this.getEncounterRules()?.itemRestrictions;
    const filteredEffects = def.effects.filter((effect) => {
      if (
        itemRules?.blockHealing &&
        (effect.op === 'heal' ||
          effect.op === 'heal_formula' ||
          effect.op === 'overheal' ||
          effect.op === 'overheal_formula' ||
          effect.op === 'delayed_heal')
      )
        return false;
      if (
        itemRules?.blockPrayerRestore &&
        (effect.op === 'restore_prayer_formula' ||
          (effect.op === 'apply_timed_effect' && effect.effectType === 'prayer_regeneration'))
      )
        return false;
      return true;
    });
    return {
      filteredEffects,
      newState: applyEffects(filteredEffects, state, {
        healing: itemRules?.blockHealing ? 0 : itemRules?.healingMultiplier,
        prayerRestore: itemRules?.blockPrayerRestore ? 0 : itemRules?.prayerRestoreMultiplier,
        blockOverheal: itemRules?.blockOverheal,
        enhancedPrayerRestoration: hasPrayerRestorationEnhancement(loadout),
        ringOfEnduranceEquipped: loadout.equipment.ring === RING_OF_ENDURANCE_ITEM_ID,
      }),
    };
  }

  private consumeInventoryItem(inventory: Inventory, index: number, def: ItemActionDef): Inventory {
    const policy =
      this.mechanicsConfig.vialSmasher === true &&
      def.consume.type === 'replace' &&
      def.consume.withId === EMPTY_VIAL_ID
        ? ({ type: 'remove' } as const)
        : def.consume;
    return consumeItem(inventory, index, policy);
  }

  private applyItemOp(action: QueuedItemAction, attackOpSeen: boolean, tracklessItemUsed: boolean): boolean {
    const player = this.player();
    // Canceling the attack splits in two, and the halves fire at different points.
    //
    // The interaction cancel is unconditional: the click cancels the attack even
    // when the consume itself is refused. Only a target clicked earlier in THIS
    // tick reaches here, and it keeps its target so movement continues ("drag to
    // melee"); the attack alone is called off.
    if (attackOpSeen) {
      player.attackInteractionActive = false;
    }

    const item = player.inventory[action.inventoryIndex];
    if (!item) return tracklessItemUsed;

    const def = getItemAction(item.id, action.option);
    if (!def) return tracklessItemUsed;

    const { track, delayTicks } = def;
    const usesTrackCooldown = track !== undefined && delayTicks > 0;

    if (usesTrackCooldown && !canUseAction(player.cooldownTracks, track, this.worldState.tick)) {
      return tracklessItemUsed;
    }

    // One trackless use per tick. Nothing else gates them — that is the point of having no
    // cooldown — so without this a queued double-click would deal double damage on one tick.
    if (track === undefined && tracklessItemUsed) {
      return tracklessItemUsed;
    }

    // Minimum HP guard (e.g. divine potions can't be drunk below 11 HP).
    if (def.minHpToUse !== undefined && player.vitals.hp < def.minHpToUse) {
      return tracklessItemUsed;
    }

    const state = this.getItemActionState(this.worldState.tick);
    // Refused like a click on cooldown: no dose used, no cooldown started, and the player keeps attacking.
    if (isItemActionRefused(def.effects, state)) return tracklessItemUsed;
    const { filteredEffects, newState } = this.resolveItemEffects(def, state, player);
    const effectApplied = newState !== state;

    player.vitals.hp = newState.playerHP;
    player.vitals.maxHp = newState.maxHP;
    player.stats = newState.stats;
    player.poisonState = newState.poisonState;
    player.prayerState = newState.prayerState;
    player.runEnergy = newState.runEnergy;
    player.specialAttack = newState.specialAttack;
    player.combatTimers = newState.combatTimers;
    player.activeEffects = newState.activeEffects;

    // Self-damage items (divine potions, rock cake, locator orb) show a real
    // damage hitsplat in OSRS — which also makes the overhead health bar
    // appear. applyEffects only mutates HP silently, so emit the visual event
    // here. Damage is clamped to the 1-HP floor handleSelfDamage enforces.
    const hasSelfDamage = filteredEffects.some(
      (effect) => effect.op === 'self_damage' || effect.op === 'self_damage_formula',
    );
    if (effectApplied && hasSelfDamage) {
      const selfDamageDealt = Math.max(0, state.playerHP - newState.playerHP);
      endPowerOfDeathOnDamage(player, selfDamageDealt);
      // Emitted even at 0: a guzzle against the 1-HP floor still hits, for 0 (OSRS Wiki, Dwarven
      // rock cake rev 15341177). `block` is the 0-damage splat type the combat path already uses.
      this.tickEvents.emit({
        type: 'hitsplat_spawned',
        targetId: PLAYER_ACTOR_ID,
        amount: selfDamageDealt,
        hitsplatType: selfDamageDealt > 0 ? 'damage' : 'block',
      });

      // Not gated on `selfDamageDealt`, for the same reason the splat above is not: the 0-damage
      // guzzle is still a hit, and Redemption procs on any hit (rev 15148542).
      //
      // Only ROCK CAKE is established as a hit. The locator orb and the divine-potion HP cost are
      // undocumented either way, and are included as a deliberate call that all three are one
      // mechanism. Revisit if a capture settles them.
      //
      // Deferred until the input FIFO finishes draining: a Redemption clicked after the item on
      // this same tick is not lit yet.
      this.selfDamageHitPending = true;
    }

    player.inventory = this.consumeInventoryItem(player.inventory, action.inventoryIndex, def);

    if (usesTrackCooldown) {
      player.cooldownTracks = applyCooldown(player.cooldownTracks, track, this.worldState.tick, delayTicks);
      this.tickEvents.emit({
        type: 'item_consumed',
        track,
        itemId: item.id,
      });
    }

    // OSRS Wiki (Food/Fast foods): eating food adds to the existing attack
    // cooldown while a weapon is mid-swing. The helper no-ops when the weapon
    // is already ready, preserving the wiki rule "eating with a ready weapon
    // adds no delay". Values stack additively across combo-eats (e.g. shark +
    // karambwan = 3 + 2 = 5 tick total delay).
    if (track !== undefined) {
      this.combatSystem.extendNextAttackTickIfActive(player.id, this.worldState.tick, getAttackDelayForTrack(track));
    }

    // The target clear is the other half, and only a consume that actually ran
    // earns it: a click refused by the cooldown leaves the player attacking.
    if (!attackOpSeen) {
      player.attackTarget = null;
    }

    if (def.playerGraphic !== undefined && effectApplied) {
      this.tickEvents.emit({
        type: 'player_graphic_applied',
        spotAnimId: def.playerGraphic,
      });
    }

    this.syncVitalsToStats();
    return tracklessItemUsed || track === undefined;
  }

  /**
   * Drop one item onto the player's current tile. A stackable id merges into a
   * pile of the same id already on that tile.
   *
   * A merge keeps the pile's original `droppedTick`, so it holds its place in the
   * right-click list instead of jumping to the top. Both servers refresh a lifetime
   * on merge, but there is no lifetime here (see GROUND_ITEM despawn note in
   * types/groundItems.ts) and ordering is the only thing the tick still drives.
   */
  private applyDropOp(action: QueuedDropAction, currentTick: number): void {
    const player = this.player();

    const item = player.inventory[action.inventoryIndex];
    if (!item) return;

    const quantity = item.quantity ?? 1;
    const stackable = isStackableItem(item.id, quantity, this.objTypeLoader);
    const tile: Coordinate = [player.position[0], player.position[1]];

    player.inventory = removeInventorySlot(player.inventory, action.inventoryIndex);

    const mergeIndex = stackable
      ? this.worldState.groundItems.findIndex(
          (pile) => pile.itemId === item.id && pile.position[0] === tile[0] && pile.position[1] === tile[1],
        )
      : -1;
    const mergeTarget = mergeIndex === -1 ? undefined : this.worldState.groundItems[mergeIndex];

    if (mergeTarget) {
      this.worldState.groundItems[mergeIndex] = {
        ...mergeTarget,
        quantity: mergeTarget.quantity + quantity,
      };
    } else {
      this.worldState.groundItems.push({
        id: this.worldState.nextGroundItemId(),
        itemId: item.id,
        quantity,
        position: tile,
        droppedTick: currentTick,
      });
    }

    this.tickEvents.emit({ type: 'ground_item_dropped', itemId: item.id, quantity, position: tile });

    this.recalculateEquipmentStats();
  }

  /**
   * Resolve a pending "Take" once the player is standing on the pile's tile.
   *
   * Runs BEFORE this tick's movement, so being on the tile is a precondition the
   * step cannot satisfy for itself: clicking a pile you already stand on takes one
   * tick, walking to one takes the arrival tick and then one more.
   *
   * Only ever one pile per tick — {@link PendingItemPickup} is a single slot that
   * {@link queuePickupGroundItem} overwrites, so several Takes inside one tick
   * resolve to the last one clicked, exactly as the client's single interaction does.
   *
   * The interaction is dropped when the pile is gone (despawned or already taken) and
   * kept alive while the player is still walking. A full inventory ends the
   * interaction rather than retrying every tick, matching the single failure message
   * the real client shows.
   */
  private processItemPickup(): void {
    const player = this.player();
    const pending = player.pendingItemPickup;
    if (!pending) return;

    const index = this.worldState.groundItems.findIndex((item) => item.id === pending.groundItemId);
    const target = index === -1 ? undefined : this.worldState.groundItems[index];
    if (!target) {
      player.pendingItemPickup = null;
      return;
    }

    if (player.position[0] !== target.position[0] || player.position[1] !== target.position[1]) {
      return;
    }

    player.pendingItemPickup = null;

    const stackable = isStackableItem(target.itemId, target.quantity, this.objTypeLoader);
    const nextInventory = addItemToInventory(player.inventory, target.itemId, target.quantity, stackable);
    if (!nextInventory) {
      // Nothing to tell the player with: this app has no chatbox, so the client's
      // "You don't have enough inventory space to hold that item." has nowhere to
      // go. The interaction simply ends and the pile stays put.
      return;
    }

    player.inventory = nextInventory;
    this.worldState.groundItems.splice(index, 1);
    this.recalculateEquipmentStats();
    this.tickEvents.emit({
      type: 'ground_item_taken',
      itemId: target.itemId,
      quantity: target.quantity,
      position: [target.position[0], target.position[1]] as Coordinate,
    });
  }

  private processActiveEffects(currentTick: number): void {
    const player = this.player();
    if (player.activeEffects.length === 0) {
      return;
    }

    const nextEffects: EffectTimer[] = [];
    for (const effect of player.activeEffects) {
      if (effect.startedTick === currentTick) {
        nextEffects.push(effect);
        continue;
      }
      const nextTicksRemaining = effect.ticksRemaining - 1;

      if (nextTicksRemaining <= 0) {
        // A delayed heal that comes due on the tick a queued hit killed the player must not
        // land: the timer band runs AFTER the queue band, so without this the death
        // screen reports positive hitpoints on a player who is already `alive: false`.
        if (effect.type === 'delayed_heal' && player.alive) {
          const cappedHeal = Math.min(player.vitals.maxHp, player.vitals.hp + effect.data.amount);
          player.vitals.hp = Math.max(player.vitals.hp, cappedHeal);
          this.syncVitalsToStats();
        }
        continue;
      }

      if (effect.type === 'prayer_regeneration' && (effect.tickDuration - nextTicksRemaining) % 12 === 0) {
        player.prayerState = {
          ...player.prayerState,
          points: Math.min(player.prayerState.maxPoints, player.prayerState.points + 1),
        };
      }

      nextEffects.push({ ...effect, ticksRemaining: nextTicksRemaining });
    }

    player.activeEffects = nextEffects;
  }

  private processPoison(currentTick: number): void {
    const player = this.player();
    // Timer is inactive while not poisoned/immune — don't advance counter.
    if (player.poisonState.poisonVarp === 0) {
      return;
    }
    // A poison applied by THIS tick's hit does not also tick down on it.
    if (player.poisonState.startedTick === currentTick) {
      return;
    }

    const nextCounter = player.poisonState.poisonTickCounter - 1;
    if (nextCounter > 0) {
      player.poisonState = {
        ...player.poisonState,
        poisonTickCounter: nextCounter,
      };
      return;
    }

    const tickResult = tickPoisonState(player.poisonState);
    player.poisonState = {
      ...tickResult.state,
      poisonTickCounter: POISON_TICK_INTERVAL,
    };

    if (tickResult.damage <= 0) {
      return;
    }

    const hitsplatType = tickResult.state.poisonVarp >= VENOM_THRESHOLD ? 'venom' : 'poison';
    this.applyDamage(
      tickResult.damage,
      'typeless',
      hitsplatType === 'venom' ? 'Venom' : 'Poison',
      this.worldState.tick,
      undefined,
      undefined,
      hitsplatType,
    );
  }

  public getItemEquipSlot(itemId: number): keyof PlayerEquipment | null {
    if (!this.objTypeLoader) return null;
    try {
      const obj = this.objTypeLoader.load(itemId);
      if (!obj.isEquippable()) return null;
      return WEAR_POS_TO_SLOT[obj.wearPos1] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * True when the item is worn ammunition (cache wear position 13). Ammo is
   * equippable but not a `keyof PlayerEquipment`, so `getItemEquipSlot` returns
   * null for it; callers use this to route to the ammo-supply equip path.
   */
  public isAmmoItem(itemId: number): boolean {
    if (!this.objTypeLoader) return false;
    try {
      const obj = this.objTypeLoader.load(itemId);
      return obj.isEquippable() && obj.wearPos1 === AMMO_WEAR_POSITION;
    } catch (error) {
      if (error instanceof Error && error.message === `Unknown item ${itemId}`) return false;
      throw error;
    }
  }

  public getEquipmentStats(): EquipmentStats {
    return this.player().equipmentStats;
  }

  private recalculateEquipmentStats(): void {
    const player = this.player();
    // https://oldschool.runescape.wiki/w/Ring_of_endurance: removing the ring
    // immediately halves its extended stamina. Every equipment mutation passes here.
    if (player.equipment.ring !== RING_OF_ENDURANCE_ITEM_ID) {
      player.activeEffects = player.activeEffects.flatMap((effect) => {
        if (effect.type !== 'stamina' || !effect.ringExtended) return [effect];
        const ticksRemaining = Math.floor(effect.ticksRemaining / 2);
        return ticksRemaining > 0 ? [{ ...effect, ticksRemaining, ringExtended: false }] : [];
      });
    }
    if (this.objTypeLoader) {
      player.equipmentStats = computeTotalEquipmentStats(player.equipment, this.objTypeLoader);
    } else {
      player.equipmentStats = createEmptyEquipmentStats();
    }
  }

  /**
   * Queue one prayer-book click on a protection prayer. Appends rather than
   * overwrites: clicks arriving inside the same tick are separate server actions
   * and the off→on pair of a 1-tick flick has to survive as two of them.
   */
  public queueProtectionPrayer(prayer: PrayerType | null): void {
    this.queueInput({ type: 'protection', prayer });
  }

  /**
   * Queue one prayer-book click on a boost prayer, which turns off every lit prayer it conflicts
   * with. Null turns every boost prayer off. See {@link queueProtectionPrayer}.
   */
  public queueBoostPrayer(prayer: PrayerType | null): void {
    this.queueInput({ type: 'boost', prayer });
  }

  /**
   * Queue one prayer-book click on an independent prayer. Unlike the slot clicks this is a
   * membership toggle: it never evicts another prayer. See {@link queueProtectionPrayer}.
   */
  public queueIndependentPrayer(prayer: PrayerType): void {
    this.queueInput({ type: 'independent', prayer });
  }

  /**
   * Queue one quick-prayer orb click. The op is a flip of the quick-prayer flag, so
   * the direction is decided here against live simulation state, never by the caller
   * — two clicks inside one tick are two actions that land back on the starting state
   * (https://oldschool.runescape.wiki/w/Prayer#Quick_prayers).
   */
  public queueQuickPrayerToggle(selections: readonly PrayerType[]): void {
    this.queueInput({ type: 'quickPrayers', selections: [...selections] });
  }

  /** Queue one run-orb click. Same flip semantics as {@link queueQuickPrayerToggle}. */
  public queueRunToggle(): void {
    this.queueInput({ type: 'run_toggle' });
  }

  /**
   * Client-side prediction of the queued prayer inputs: what the prayer state
   * will be once the next tick drains the queue. The real client lights the button
   * the moment it is clicked and lets the server confirm, which is exactly what the
   * interface reads this for.
   */
  public resolvePendingPrayerInput(): PrayerInputOutcome {
    return projectPendingPrayerInput(
      buildPendingPrayerProjection(this.player(), this.worldState.tick, this.getPrayerRestoreProjectionRules()),
    );
  }

  /** See {@link PrayerRestoreProjectionRules}. */
  public getPrayerRestoreProjectionRules(): PrayerRestoreProjectionRules {
    const itemRules = this.getEncounterRules()?.itemRestrictions;
    return {
      allowed: itemRules?.blockPrayerRestore !== true,
      ...(itemRules?.prayerRestoreMultiplier === undefined ? {} : { multiplier: itemRules.prayerRestoreMultiplier }),
    };
  }

  /** The encounter's typed payload for the current tick: fight state and visuals together. */
  public getEncounterSnapshot(): EncounterSnapshot {
    return this.encounter.getSnapshot({
      tick: this.worldState.tick,
      mechanics: this.mechanicsConfig,
      world: this.worldState,
    });
  }

  /**
   * Snapshot this engine as the START of a run.
   *
   * The loadout below is read live, which is only the run's STARTING loadout because every
   * caller invokes this at run start (right after seeding inventory/equipment/supplies, before
   * the first tick). Calling it mid-run instead yields a bootstrap whose "initial" loadout is
   * whatever the player is holding now, and a takeover reconstructing from it replays the whole
   * fight with gear the player did not open with.
   */
  public getRunConfig(): EngineRunConfig {
    const player = this.player();
    return {
      completionOwnership: this.completionOwnership,
      encounter: {
        kind: this.encounter.kind,
        seeds: this.encounter.getSeeds(),
      },
      bootstrap: {
        version: ENGINE_RUN_BOOTSTRAP_VERSION,
        startPosition: [...this.runStartPosition] as Coordinate,
        baseStats: cloneBaseStats(this.configuredStats),
        ...(this.startHp === undefined ? {} : { startHp: this.startHp }),
        enableIntro: this._introEnabled,
        ...(this.encounterConfig === undefined ? {} : { encounterConfig: this.encounterConfig }),
        mechanicsConfig: { ...this.mechanicsConfig },
        inventory: player.inventory.map((slot) => (slot ? { ...slot } : null)),
        equipment: { ...player.equipment },
        combatSupplies: cloneCombatSupplies(player.combatSupplies),
        attackStylePerCategory: { ...this._attackStylePerCategory },
        prepotApplied: this.prepotApplied,
        combatSeed: this.combatSeed,
      },
    };
  }

  private seedCombatRandom(seed: number): void {
    this.combatSeed = seed;
    this.combatRandom = this.combatRandomOverride ?? mulberry32(seed);
  }

  /**
   * Restore every input a reconstruction must reproduce, before the world is rebuilt.
   *
   * Ordering is load-bearing: these all feed `initializeWorld`/`createPlayerActor`, so a caller
   * that applies them after `reset()` gets a world built from the wrong baseline.
   */
  private applyRunBootstrap(bootstrap: EngineRunBootstrap): void {
    this.configuredStats = cloneBaseStats(bootstrap.baseStats);
    this.startHp = Number.isFinite(bootstrap.startHp) ? bootstrap.startHp : undefined;
    this._introEnabled = bootstrap.enableIntro;
    this._attackStylePerCategory = { ...bootstrap.attackStylePerCategory };
    this.seedCombatRandom(bootstrap.combatSeed);
    this.setMechanicsConfig(bootstrap.mechanicsConfig);
  }

  private rebuildActivePrayers(): void {
    const player = this.player();
    const prayers: PrayerType[] = [];
    if (player.activePrayer && PRAYER_CATEGORIES[player.activePrayer] === 'protection') {
      prayers.push(player.activePrayer);
    }
    for (const prayer of player.boostPrayers) {
      if (PRAYER_CATEGORIES[prayer] === 'boost') prayers.push(prayer);
    }
    for (const prayer of player.independentPrayers) {
      if (PRAYER_CATEGORIES[prayer] === 'independent') prayers.push(prayer);
    }
    player.prayerState = { ...player.prayerState, activePrayers: prayers };
  }

  private enforceQuickPrayerInvariant(): void {
    const player = this.player();
    if (player.activePrayer === null && player.boostPrayers.length === 0 && player.independentPrayers.length === 0) {
      player.quickPrayersActive = false;
    }
  }

  /**
   * "Activating or deactivating Rapid Heal resets the countdown timer … to 30 seconds or 60
   * seconds, respectively" (https://oldschool.runescape.wiki/w/Rapid_Heal?oldid=14872669). Driven by
   * real on/off transitions only, so a rejected click or a quick-prayer op that keeps it lit does not
   * restart the timer.
   */
  private restartHpRegen(tick: number, rapidHealActive: boolean): void {
    const player = this.player();
    player.combatTimers = { ...player.combatTimers, hpRegenTick: tick + hpRegenInterval(rapidHealActive) };
  }

  /**
   * The single shutdown path for "prayer points reached zero".
   *
   * Drain and Redemption both land here so the two cannot drift into different reset shapes.
   */
  private finalizePrayerDepletion(tick: number): void {
    const player = this.player();
    // Going dark at 0 points is a deactivation like any other. Read before the prayers are cleared:
    // prayer drain has already emptied `prayerState.activePrayers` by the time it calls this.
    if (player.independentPrayers.includes(PrayerType.RapidHeal)) this.restartHpRegen(tick, false);
    player.prayerState = {
      ...player.prayerState,
      points: 0,
      drainCounter: 0,
      activePrayers: [],
      prayerActivationTicks: {},
    };
    player.activePrayer = null;
    player.boostPrayers = [];
    player.independentPrayers = [];
    player.quickPrayersActive = false;
    this.protectionPrayerActivatedTick = null;
    this.tickEvents.setTick(tick);
    this.tickEvents.emit({ type: 'prayer_depleted', actorId: player.id });
  }

  /**
   * Redemption: a hit leaving the player under 10% of max HP heals and burns every prayer point.
   *
   * Callers MUST invoke this after their own death check. Redemption cannot save a lethal hit
   * (OSRS Wiki rev 15148542), so a proc that healed first would make lethal hits survivable — hence
   * the `alive` and `hp > 0` guards rather than a pre-death insertion point.
   *
   * It deliberately does not require the hit to have dealt damage or to have crossed the threshold
   * on this hit: a 0-damage hit while already under 10% procs (same source). Zeroing the prayers
   * here is also what stops a second hitsplat in the same tick from proccing again.
   */
  private tryRedemption(tick: number): void {
    const player = this.player();
    if (!player.alive || player.activePrayer !== PrayerType.Redemption || player.prayerState.points <= 0) {
      return;
    }
    const { hp, maxHp } = player.vitals;
    // `hp * 10 < maxHp` is the integer-safe form of "below 10%": at 99 max it procs at 9 and not at
    // 10, matching the wiki's worked example.
    if (hp <= 0 || hp * 10 >= maxHp) return;

    const heal = Math.floor(player.stats.prayer.max * REDEMPTION_HEAL_FRACTION);
    player.vitals.hp = Math.min(maxHp, hp + heal);

    this.finalizePrayerDepletion(tick);

    this.tickEvents.setTick(tick);
    this.tickEvents.emit({ type: 'player_graphic_applied', spotAnimId: REDEMPTION_SPOTANIM_ID });
    this.syncVitalsToStats();
  }

  public getState(): SimulationState {
    const player = this.player();
    if (
      player.vitals.hp !== player.stats.hitpoints.current ||
      player.prayerState.points !== player.stats.prayer.current
    ) {
      log.warn('Simulation', 'Vitals desync detected in getState()', {
        playerHP: player.vitals.hp,
        statsHP: player.stats.hitpoints.current,
        prayerPoints: player.prayerState.points,
        statsPrayer: player.stats.prayer.current,
      });
    }

    const state = toSimulationState(this.worldState, this);
    state.pendingSpecialAttackActive = this.projectSpecialAttackState();
    return state;
  }

  /**
   * `runMechanics` override the player's mechanics for this run only (see `EncounterPracticeRestart`);
   * the next reset drops them. A bootstrap's mechanics already include whatever its run overrode.
   */
  public reset(
    startPos?: Coordinate,
    runConfig?: EngineRunConfig,
    runMechanics: Readonly<Partial<MechanicsConfig>> = {},
  ): void {
    const bootstrap = resolveRunBootstrap(runConfig ?? null);
    const combatSeed = bootstrap?.combatSeed ?? normalizeCombatSeed(undefined);
    if (runConfig?.encounter?.seeds) {
      this.encounter.reset(runConfig.encounter.seeds);
    } else {
      this.encounter.reset();
    }
    this.runMechanicsOverride = { ...runMechanics };
    if (bootstrap) {
      this.applyRunBootstrap(bootstrap);
    } else {
      this.mergeMechanicsConfig();
      // A fresh run gets a fresh fight. Reusing the previous seed would make every retry of an
      // encounter roll the same damage in the same order.
      this.seedCombatRandom(combatSeed);
    }
    // After the mechanics: the run setup can choose where the run opens.
    const playerStart = startPos ?? bootstrap?.startPosition ?? this.getEncounterDefaultPlayerStart(this.encounter);
    this.runStartPosition = [...playerStart] as Coordinate;
    const currentInventory = this.player().inventory;
    const currentCombatSupplies = cloneCombatSupplies(this.player().combatSupplies);

    this.failedCondition = null;
    this.prepotApplied = false;
    this.playerActionsUnlockTick = Number.NEGATIVE_INFINITY;
    this.walkTargetDiscarded = false;
    this.pendingNpcDefeats = [];
    // A command queued against the old run must not land in the new one.
    this.pendingEncounterCommands = [];
    if (runConfig) {
      this.completionOwnership = runConfig.completionOwnership;
    }
    this.npcDefinitions = this.encounter.getNpcDefinitions?.() ?? new NpcDefinitionCollection();
    this.protectionPrayerActivatedTick = null;
    this.protectionPrayersDisabledUntilTick = Number.NEGATIVE_INFINITY;
    this.encounterRules = this.encounter.getEngineRules?.();
    this.damageHistory = [];
    this.eventLog = [];

    this.combatSystem.reset();
    this.applyEncounterArenaConfig(this.encounter);
    this.initializeWorld(playerStart, currentInventory);
    this.player().combatSupplies = currentCombatSupplies;
    this.recalculateEquipmentStats();
  }

  /**
   * Scans inventory for items with persistent buff effects (stat boosts,
   * saturated heart, divine decay locks, timed effects like stamina) and applies those
   * effects to the player without consuming the items.
   */
  public applyPrepotEffects(): void {
    // Set on invocation, not on effect: what a reconstruction has to reproduce is whether the
    // run start called this at all, and a no-op call still leaves the engine reproducible.
    this.prepotApplied = true;
    if (!this.mechanicsConfig.autoPrepot) return;

    const player = this.player();
    const seen = new Set<number>();

    for (let i = 0; i < player.inventory.length; i++) {
      const item = player.inventory[i];
      if (!item) continue;
      if (seen.has(item.id)) continue;

      const def = ITEM_ACTIONS[item.id];
      if (!def || !isPrepottable(def)) continue;

      seen.add(item.id);

      const prepotEffects = getPrepotEffects(def.effects);
      if (prepotEffects.length === 0) continue;

      const state: ItemActionState = {
        playerHP: player.vitals.hp,
        maxHP: player.vitals.maxHp,
        stats: player.stats,
        poisonState: player.poisonState,
        prayerState: player.prayerState,
        runEnergy: player.runEnergy,
        specialAttack: player.specialAttack,
        combatTimers: player.combatTimers,
        cooldownTracks: player.cooldownTracks,
        activeEffects: player.activeEffects,
        currentTick: this.worldState.tick,
      };

      const newState = applyEffects(prepotEffects, state, {
        ringOfEnduranceEquipped: player.equipment.ring === RING_OF_ENDURANCE_ITEM_ID,
      });

      player.vitals.hp = newState.playerHP;
      player.vitals.maxHp = newState.maxHP;
      player.stats = newState.stats;
      player.poisonState = newState.poisonState;
      player.prayerState = newState.prayerState;
      player.runEnergy = newState.runEnergy;
      player.combatTimers = newState.combatTimers;
      player.activeEffects = newState.activeEffects;
    }

    const hasPurgingStaffEquipped = player.equipment.weapon === PURGING_STAFF_ITEM_ID;
    const hasPurgingStaffInInventory = player.inventory.some(
      (slot) => slot !== null && slot.id === PURGING_STAFF_ITEM_ID,
    );
    if (hasPurgingStaffEquipped || hasPurgingStaffInInventory) {
      const modTimers = castMarkOfDarknessTimer(
        player.stats.magic.max,
        true, // Always count as having purging staff for duration calc
        player.combatTimers,
      );
      if (modTimers) {
        player.combatTimers = modTimers;
      }
    }

    this.syncVitalsToStats();
  }

  public canAdvance(): boolean {
    return this.player().alive && !this._introActive && this.encounter.getOutcome().phase !== 'victory';
  }

  public getEncounterOutcome(): EncounterOutcome {
    return this.encounter.getOutcome();
  }

  /**
   * External pause flag toggled by the tutorial system. Independent of
   * `canAdvance()` (which gates on player alive + intro state) — the wiring
   * layer is responsible for honoring this flag in its tick loop.
   */
  public setTutorialPaused(paused: boolean): void {
    this._tutorialPaused = paused;
  }

  public setCompletionOwnership(ownership: EncounterCompletionOwnership): void {
    this.completionOwnership = ownership;
  }

  public isTutorialPaused(): boolean {
    return this._tutorialPaused;
  }

  public getIntroActive(): boolean {
    return this._introActive;
  }

  public completeIntro(): void {
    if (!this._introActive) return;
    this._introActive = false;
    this.tickEvents.setTick(SIMULATION_START_TICK);
    this.tickEvents.emit({ type: 'intro_completed' });
    this.lastTickEvents = this.tickEvents.flush();
  }

  private acceptsEncounterCommand(command: EncounterCommand): boolean {
    return (
      baseEncounterKind(this.encounter.kind) === baseEncounterKind(command.encounter) &&
      this.encounter.executeCommand !== undefined
    );
  }

  /**
   * Player-facing entry point (debug buttons, tutorials, replay): the command takes effect at the
   * start of the next tick, as a server applies a request on its tick boundary. Running it
   * mid-tick stamped spawns with a tick the presentation was already partway through, so a
   * one-tick spawn clip could start late or not at all, depending on when the click landed.
   * Returns whether this encounter accepts the command; acceptance is decided now, not at the
   * tick, so a caller can report a mismatched command immediately.
   */
  /** The fresh run this encounter offers for a practice command, or null to run it in-fight. */
  public planPracticeRestart(command: EncounterCommand): EncounterPracticeRestart | null {
    if (baseEncounterKind(this.encounter.kind) !== baseEncounterKind(command.encounter)) return null;
    return this.encounter.planPracticeRestart?.(command, this.restartMechanics(), this.restartContext()) ?? null;
  }

  /**
   * Where a plain restart of this run (a fresh run of the player's setup) opens, by the encounter's
   * choice; null for its default start. Pass the answer to `reset` so the run records it.
   */
  public planRestartStart(): Coordinate | null {
    return this.encounter.planRestartStart?.(this.restartMechanics(), this.restartContext()) ?? null;
  }

  /** A restart drops this run's overrides (`reset`), so it is planned against the player's setup. */
  private restartMechanics(): MechanicsConfig {
    return mergeMechanicsConfig(this.getEncounterDefaultMechanicsConfig(), this.playerMechanicsConfig);
  }

  private restartContext(): EncounterRestartContext {
    return { playerPos: [...this.player().position] as Coordinate };
  }

  public queueEncounterCommand(command: EncounterCommand): boolean {
    if (!this.acceptsEncounterCommand(command)) return false;
    this.pendingEncounterCommands.push(command);
    return true;
  }

  /**
   * Runs the command NOW, mid-tick, stamped with the tick that last completed. Scenario setup for
   * tests and drivers that pin a command to an exact tick; live input goes through
   * {@link queueEncounterCommand} so that it and its replay land on the same tick.
   */
  public executeEncounterCommand(command: EncounterCommand): boolean {
    if (!this.acceptsEncounterCommand(command)) return false;
    const gameEvents = this.runEncounterCommand(command);
    if (gameEvents === null) return false;
    for (const gameEvent of gameEvents) this.tickEvents.emit(gameEvent);
    if (gameEvents.length > 0) {
      const flushed = this.tickEvents.flush();
      this.lastTickEvents = [...this.lastTickEvents, ...flushed];
    }
    return true;
  }

  private runPendingEncounterCommands(): void {
    const commands = this.pendingEncounterCommands;
    this.pendingEncounterCommands = [];
    for (const command of commands) {
      for (const gameEvent of this.runEncounterCommand(command) ?? []) this.tickEvents.emit(gameEvent);
    }
  }

  private runEncounterCommand(command: EncounterCommand): readonly EmittableGameEvent[] | null {
    const result = this.encounter.executeCommand?.(
      command,
      {
        playerPos: this.player().position,
        tick: this.worldState.tick,
        world: this.worldState,
        // Encounter commands are the practice aids, so everything they spawn is tagged here, once,
        // for every encounter. Mechanic toggles then leave these instances alone.
        spawnNpc: (actor) => {
          actor.spawnOrigin = 'practice';
          this.spawnEncounterNpc(actor);
        },
        despawnNpc: (npcId) => this.despawnEncounterNpc(npcId),
      },
      this.mechanicsConfig,
    );
    return result ? (result.gameEvents ?? []) : null;
  }

  /**
   * Practice tool: directly set the current HP of the primary boss NPC.
   * Encounter-agnostic so Practice's boss HP control works for any boss. Returns the
   * HP actually applied.
   */
  public setBossHp(hp: number): number {
    const npcs = this.worldState.getNpcs();
    const boss = npcs.find((npc) => npc.role === 'boss') ?? npcs[0];
    if (!boss) return 0;
    const wasAlive = boss.alive;
    if (!wasAlive && !this.pendingNpcDefeats.some((pending) => pending.actor === boss)) return boss.vitals.hp;
    const clamped = Math.max(0, Math.min(boss.vitals.maxHp, Math.floor(hp)));
    boss.vitals.hp = clamped;
    if (!wasAlive && clamped > 0) {
      // A new life: hits queued against the one just ended do not carry over.
      reviveNpc(boss);
      this.pendingNpcDefeats = this.pendingNpcDefeats.filter((pending) => pending.actor !== boss);
    } else if (wasAlive && clamped === 0) {
      // A scripted kill, processed at once (it also clears burn and poison, so dragging the bar back
      // up cannot resume them). Queue the same defeat a lethal hit would: without it the boss is left
      // dead but undefeated, `onNpcDefeated` never runs, and the encounter never resolves.
      recordNpcLethalTransition(boss, this.worldState.tick, 'scripted');
      this.startNpcDeath(boss);
      this.pendingNpcDefeats.push({ actor: boss, defeat: { npcId: boss.id, tick: this.worldState.tick } });
    }
    this.encounter.syncBossHp?.(clamped, { world: this.worldState });
    return clamped;
  }

  /**
   * Practice tool: apply one of the encounter's named HP presets. Unlike the raw
   * health slider this is a PHASE jump — an encounter whose phases own actors (Zuk's
   * Jad and Jal-MejJak) rebuilds that phase, so the same chip always lands on the same
   * fight state. Encounters without `enterBossHpPhase` just get the HP set.
   */
  public applyBossHpPreset(hp: number): void {
    const applied = this.setBossHp(hp);
    if (applied <= 0) return;
    this.encounter.enterBossHpPhase?.(applied, {
      tick: this.worldState.tick,
      world: this.worldState,
      spawnNpc: (actor) => this.spawnEncounterNpc(actor),
      despawnNpc: (npcId) => this.despawnEncounterNpc(npcId),
    });
  }

  public getEncounterKind(): string {
    return this.encounter.kind;
  }

  private calculateDamage(baseDamage: number, attackType?: DamageType, prayerReduction?: PrayerReduction): number {
    return calculatePrayerDamage(baseDamage, attackType, this.player().activePrayer, prayerReduction);
  }

  private applyEnvironmentalDamage(damage: EnvironmentalDamage, tick: TickNumber): void {
    const hit = damage.accuracy === undefined || this.rollCombat() < damage.accuracy;
    this.applyDamage(
      hit ? damage.baseDamage : 0,
      damage.attackType,
      damage.source,
      tick,
      damage.prayerReduction,
      damage.playerPosition,
    );
    if (!hit) return;
    const lockoutTicks = damage.disablesProtectionPrayersForTicks;
    if (damage.applyPoison !== undefined && this.player().alive) this.applyPoisonToPlayer(damage.applyPoison);
    if (lockoutTicks === undefined || !this.player().alive) return;
    this.disableProtectionPrayersUntil(tick + lockoutTicks);
    this.removeProtectionPrayer(tick);
  }

  private applyDamage(
    rawBaseDamage: DamageValue,
    attackType: DamageType,
    source: FailCondition,
    tick: TickNumber,
    prayerReduction?: PrayerReduction,
    playerPosition?: Coordinate,
    hitsplatTypeOverride?: 'damage' | 'block' | 'poison' | 'venom',
  ): void {
    const player = this.player();
    let baseDamage = Math.max(0, Math.floor(resolveDamage(rawBaseDamage, this.rollCombat)));
    const rules = this.getEncounterRules();
    const incomingDamageMultiplier = resolveDynamic(rules?.incomingDamageMultiplier, this.buildEngineContext());
    if (incomingDamageMultiplier !== undefined) {
      baseDamage = Math.max(0, Math.floor(baseDamage * incomingDamageMultiplier));
    }
    const hpBefore = player.vitals.hp;
    if (attackType === 'melee') baseDamage = Math.floor(baseDamage * powerOfDeathMeleeMultiplier(player, tick));
    const effectiveDamage = this.calculateDamage(baseDamage, attackType, prayerReduction);

    if (!this.mechanicsConfig.infiniteHealth) {
      endPowerOfDeathOnDamage(player, effectiveDamage);
      player.vitals.hp -= effectiveDamage;
      if (player.vitals.hp < 0) {
        player.vitals.hp = 0;
      }
    }

    // Captured once, because Redemption can raise `player.vitals.hp` further down. History, the
    // event log, and the encounter hook all describe the HIT, not the healed state that follows it.
    const hpAfter = player.vitals.hp;

    const prayedCorrectly = attackType === 'typeless' ? null : this.didPrayCorrectly(attackType);

    this.damageHistory.push({
      tick,
      source,
      targetId: PLAYER_ACTOR_ID,
      baseDamage,
      attackType,
      activePrayer: player.activePrayer,
      prayedCorrectly,
      effectiveDamage,
      hpBefore,
      hpAfter,
      playerPosition,
    });

    this.logEvent({
      tick,
      type: EventType.DAMAGE_TAKEN,
      source,
      attackType,
      baseDamage,
      effectiveDamage,
      prayedCorrectly,
      hpAfter,
    });

    this.tickEvents.emit({
      type: 'hit_applied',
      targetId: PLAYER_ACTOR_ID,
      // `playerPosition` is the caller's snapshot of where the hit was aimed; hazards that do not
      // pass one land on the player wherever they now are.
      targetPosition: [...(playerPosition ?? player.position)] as Coordinate,
      damage: effectiveDamage,
      blocked: effectiveDamage === 0,
      prayedCorrectly,
      attackKind:
        attackType === 'typeless'
          ? 'typeless'
          : attackType === 'magic'
            ? 'magic_shadow'
            : attackType === 'range'
              ? 'range_shadow'
              : 'melee_crush',
    });
    this.tickEvents.emit({
      type: 'hitsplat_spawned',
      targetId: PLAYER_ACTOR_ID,
      amount: effectiveDamage,
      hitsplatType: hitsplatTypeOverride ?? (effectiveDamage > 0 ? 'damage' : 'block'),
    });

    if (!this.mechanicsConfig.infiniteHealth && player.vitals.hp <= 0) {
      player.alive = false;
      this.failedCondition = 'Death';
      this.logEvent({
        tick,
        type: EventType.DEATH,
        cause: source,
      });
      this.tickEvents.emit({
        type: 'actor_died',
        actorId: PLAYER_ACTOR_ID,
      });
    }

    // Poison and venom pulses are held OUT of Redemption. The permitted sources establish "any hit,
    // including a 0-damage one" but never classify damage-over-time pulses, and those pulses only
    // reach this generic path incidentally. Excluding them keeps an unsettled rule from being
    // decided by routing; the attack that applied the poison still procs normally.
    if (hitsplatTypeOverride !== 'poison' && hitsplatTypeOverride !== 'venom') {
      this.tryRedemption(tick);
    }

    this.notifyEncounterPlayerDamageTaken({
      sourceKind: 'environment',
      source,
      tick,
      attackType,
      baseDamage,
      effectiveDamage,
      prayedCorrectly,
      hpBefore,
      hpAfter,
      ...(hitsplatTypeOverride === 'poison' || hitsplatTypeOverride === 'venom'
        ? { damageOverTime: hitsplatTypeOverride }
        : {}),
    });

    this.syncVitalsToStats();
  }

  private notifyEncounterPlayerDamageTaken(info: EncounterPlayerDamageInfo): void {
    const rules = this.getEncounterRules();
    if (rules?.onPlayerDamageTaken) {
      const result = rules.onPlayerDamageTaken(info, this.buildPlayerLockContext());
      const fail = this.processHookResult(result);
      if (fail) {
        this.applyFailCondition(fail, info.tick);
      }
    }
  }

  private didPrayCorrectly(attackType: Exclude<DamageType, 'typeless'>): boolean {
    return didPrayCorrectlyShared(attackType, this.player().activePrayer);
  }

  private applyFailCondition(condition: FailCondition, tick: number): void {
    const player = this.player();
    player.alive = false;
    this.failedCondition = condition;
    this.logEvent({ tick, type: EventType.DEATH, cause: condition });
    this.tickEvents.emit({ type: 'actor_died', actorId: PLAYER_ACTOR_ID });
  }

  private syncVitalsToStats(): void {
    const player = this.player();
    player.stats = {
      ...player.stats,
      hitpoints: {
        current: player.vitals.hp,
        max: player.vitals.maxHp,
      },
      prayer: {
        current: player.prayerState.points,
        max: player.prayerState.maxPoints,
      },
    };
  }

  private applyPoisonToPlayer(poisonVarp: number): void {
    const player = this.player();
    const currentVarp = player.poisonState.poisonVarp;
    if (currentVarp < 0 || currentVarp >= VENOM_THRESHOLD) {
      return;
    }

    // Reset tick counter on 0→nonzero transition so the first cycle is a full 30 ticks. The
    // timer band runs AFTER the hit that poisons, so recording the tick is what stops it
    // spending one of those 30 on the application tick itself.
    const resetCounter = currentVarp === 0;
    player.poisonState = {
      ...player.poisonState,
      poisonVarp: Math.max(currentVarp, poisonVarp),
      ...(resetCounter ? { poisonTickCounter: POISON_TICK_INTERVAL, startedTick: this.worldState.tick } : {}),
    };
  }

  public getFailedCondition(): FailCondition | null {
    return this.failedCondition;
  }

  public getDamageHistory(): DamageHistoryEntry[] {
    return this.damageHistory;
  }

  public getEventLog(): SimulationEvent[] {
    return this.eventLog;
  }

  public getMechanicsConfig(): MechanicsConfig {
    return { ...this.mechanicsConfig };
  }

  public getNpcHistory(npcId: string): Map<TickNumber, Coordinate> {
    const npc = this.worldState.getNpc(npcId);
    return npc?.history ?? new Map<TickNumber, Coordinate>();
  }

  public getPlayerAttackCooldown(playerId: string, currentTick: number): number {
    const nextTick = this.combatSystem.getNextAttackTick(playerId);
    if (nextTick === undefined) return 0;
    return Math.max(0, nextTick - currentTick);
  }

  public getPlayerNextAttackTick(playerId: string): number {
    return this.combatSystem.getNextAttackTick(playerId) ?? -1;
  }

  public getNpcAttackTimer(npcId: string): NpcAttackTimer | null {
    const npc = this.worldState.getNpc(npcId);
    if (!npc?.alive) return null;
    return this.npcDefinitions.attackTimer(npc, this.buildNpcDefinitionContext());
  }

  public getPlayerAttackSpeed(playerId: string): number {
    // Prefer the cycle length used to schedule the CURRENT cooldown so the
    // metronome UI stays stable across weapon/style swaps mid-cooldown. Fall
    // back to the current effective speed before the first attack.
    const scheduled = this.combatSystem.getScheduledAttackCycle(playerId);
    if (scheduled !== undefined) return scheduled;
    return getPlayerEffectiveCombatParams(this.player()).attackSpeed;
  }

  public get isAlive(): boolean {
    return this.player().alive;
  }

  public get prayerState(): PrayerState {
    return this.player().prayerState;
  }

  public get stats(): PlayerStats {
    return this.player().stats;
  }

  public get specialAttack(): SpecialAttackState {
    return this.player().specialAttack;
  }

  public get combatTimers(): CombatTimers {
    return this.player().combatTimers;
  }

  public get inventory(): Inventory {
    return this.player().inventory;
  }

  public get runEnergy(): RunEnergyState {
    return this.player().runEnergy;
  }

  public get activePrayer(): PrayerType | null {
    return this.player().activePrayer;
  }

  public get boostPrayers(): readonly PrayerType[] {
    return this.player().boostPrayers;
  }

  public get independentPrayers(): readonly PrayerType[] {
    return this.player().independentPrayers;
  }

  public get markOfDarknessActive(): boolean {
    return this.player().combatTimers.markOfDarknessActiveTicks > 0;
  }

  public get playerEquipment(): PlayerEquipment {
    return this.player().equipment;
  }

  public get equipmentStats(): EquipmentStats {
    return this.player().equipmentStats;
  }

  public get cooldownTracks(): CooldownTrackState {
    return this.player().cooldownTracks;
  }

  public get pendingProtectionPrayer(): [boolean, PrayerType | null] {
    const pending = this.resolvePendingPrayerInput();
    return [pending.protectionTouched, pending.protection];
  }

  public get pendingBoostPrayers(): [boolean, readonly PrayerType[]] {
    const pending = this.resolvePendingPrayerInput();
    return [pending.boostTouched, pending.boost];
  }

  public get pendingIndependentPrayers(): [boolean, readonly PrayerType[]] {
    const pending = this.resolvePendingPrayerInput();
    return [pending.independentTouched, pending.independent];
  }

  public get pendingSpecialAttackToggles(): number {
    return this.getPendingSpecialAttackToggles();
  }

  public get playerHistory(): Map<TickNumber, Coordinate> {
    return this.player().history;
  }

  public get currentTick(): TickNumber {
    return this.worldState.tick;
  }

  public getLastTickEvents(): GameEvent[] {
    return this.lastTickEvents;
  }
}
