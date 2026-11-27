import type { MonsterStatOverrides } from '../../types/monsterStatOverride';
import type { CombatSkill } from '../../types/playerState';
import type { Coordinate, FailCondition, MechanicsConfig, PrayerType, SimulationEvent } from '../../types/simulation';
import type { NpcActor } from '../actors/NpcActor';
import type { PlayerActor } from '../actors/PlayerActor';
import type { ActorId, DamageType, EquipmentSlot } from '../actors/types';
import type { ArenaConfig } from '../arena/ArenaConfig';
import type {
  AttackResolution,
  DamageAppliedInfo,
  PrayerCheckTiming,
  PrayerReduction,
  SourceDeathPolicy,
} from '../combat/CombatSystem';
import type { DamageValue } from '../combat/damageCalculation';
import type { EffectiveCombatParams } from '../combat/weaponCombatData';
import type { EmittableGameEvent, TickEvents } from '../events/TickEvents';
import type { AttackKind, HitsplatType, OverheadTextSegment } from '../events/types';
import type { NpcDefinitionCollection } from '../npcs';
import type { WorldState } from '../WorldState';
import type { EncounterCommand } from './commands';
import type { EncounterOutcome } from './outcome';
import type { EncounterSnapshot, EncounterSnapshotContext } from './snapshot';

export type EncounterPrayerAccess = 'allowed' | 'blocked';

export interface EncounterEngineContext {
  tick: number;
  player: Readonly<PlayerActor>;
  world: Readonly<WorldState>;
}

/**
 * The context of the per-tick hooks that may lock the player's actions
 * ({@link EncounterEngineRules.onTickStart}, {@link EncounterEngineRules.onPlayerDamageTaken}).
 * Rule queries and damage calculations get the plain {@link EncounterEngineContext}.
 */
export type EncounterPlayerLockContext = EncounterEngineContext & Pick<EncounterContext, 'lockPlayerActionsUntil'>;

export interface EncounterPrayerDrainParams {
  totalDrainEffect: number;
  drainResistance: number;
  prayerBonus: number;
}

export interface EncounterPlayerDamageInfo {
  sourceKind: 'combat' | 'environment';
  /** Encounter/hazard-owned damage source label, also used for damage history and failure. */
  source: FailCondition;
  tick: number;
  attackType: DamageType;
  baseDamage: number;
  effectiveDamage: number;
  prayedCorrectly: boolean | null;
  hpBefore: number;
  hpAfter: number;
  /** Set when the damage is a poison/venom pulse rather than a hit from an enemy or hazard. */
  damageOverTime?: 'poison' | 'venom';
  /** For a combat hit from an NPC: the launching instance's NPC type, kept even once it has been removed. */
  sourceNpcTypeId?: number;
}

/** The engine applies mutations (e.g. run energy drain) then checks for failure. */
export interface EncounterHookEffect {
  fail?: FailCondition;
  /** Delta applied to player run energy (0-10000 scale). Negative = drain. */
  runEnergyDelta?: number;
  prayerPointsDelta?: number;
  /** Levels drained from the player's current combat stats (floored at 0), e.g. a Jal-MejRah hit. */
  playerStatDrains?: Readonly<Partial<Record<CombatSkill, number>>>;
  /** Additional splats emitted at the hook's normal timing (after the triggering damage splat). */
  playerHitsplats?: readonly { amount: number; hitsplatType: HitsplatType }[];
  /** A game chat line emitted with the hook. */
  gameMessage?: readonly OverheadTextSegment[];
}

export type HookResult = FailCondition | EncounterHookEffect | null;

/**
 * A rule value that may instead be computed from live encounter state, re-read at each use
 * rather than captured once.
 *
 * Resolve it with {@link resolveDynamic} at the layer that HAS a context. `CombatBridge`
 * deliberately keeps taking plain numbers, so the engine stays the only place that resolves.
 */
export type EncounterDynamic<T> = T | ((ctx: EncounterEngineContext) => T);

/** Reads either form of an {@link EncounterDynamic}, preserving `undefined` for "unset". */
export function resolveDynamic<T>(value: EncounterDynamic<T> | undefined, ctx: EncounterEngineContext): T | undefined {
  return typeof value === 'function' ? (value as (ctx: EncounterEngineContext) => T)(ctx) : value;
}

export interface EncounterEngineRules {
  /** Burst/Barrage fan-out and the Venator bow ricochet are off only where an encounter models single combat. */
  multiCombat?: boolean;
  prayerRestrictions?: {
    protection?: EncounterPrayerAccess | { expiresAfterTicks: number };
    offensive?: EncounterPrayerAccess;
  };
  prayerDrain?: {
    multiplier?: number;
    modifyDrainResistance?(params: EncounterPrayerDrainParams, ctx: EncounterEngineContext): number;
  };
  itemRestrictions?: {
    blockHealing?: boolean;
    blockPrayerRestore?: boolean;
    healingMultiplier?: number;
    prayerRestoreMultiplier?: number;
    /** Cap every heal at max HP — disables Saradomin brew / anglerfish overheal (Frailty). */
    blockOverheal?: boolean;
  };
  /**
   * Subtract floor(base max Hitpoints * reduction) at encounter start.
   * Applied once in initializeWorld; `undefined` leaves max HP unchanged.
   */
  playerMaxHpReduction?: number;
  modifyPlayerCombatParams?(params: EffectiveCombatParams, ctx: EncounterEngineContext): EffectiveCombatParams;
  consumePlayerGuaranteedMaxHit?(ctx: EncounterEngineContext): boolean;
  /**
   * Floor the player's ACCURATE hit at the returned damage, leaving higher rolls alone
   * (Bloodied Blows' Wretched Strength). Read at the tick the attack is LAUNCHED — the
   * capture's opening 48 was rolled at 27 HP and landed three ticks later at 17, and
   * fitting it against the landing HP moves the whole curve. `maxHit` is the swing's own
   * first-hitsplat maximum, which differs by weapon and by target.
   */
  playerMinimumHit?(maxHit: number, ctx: EncounterEngineContext): number;
  validateAttack?(attackKind: AttackKind, targetId: ActorId, ctx: EncounterEngineContext): boolean | null;
  incomingDamageMultiplier?: EncounterDynamic<number>;
  outgoingDamageMultiplier?: EncounterDynamic<number>;
  /**
   * Restat NPCs for this encounter, keyed by npc type id. The synchronized monster dataset only
   * models a boss in its ordinary form, so anything that restats one for a single run supplies
   * the delta here rather than
   * waiting for a dataset row that will never exist. Reaches accuracy AND damage, since both
   * come out of the same calculator.
   */
  monsterStatOverrides?: MonsterStatOverrides;
  specialAttacks?: {
    energyCostMultiplier?: EncounterDynamic<number>;
    damageMultiplier?: EncounterDynamic<number>;
  };
  /**
   * Called at the start of each tick, BEFORE player movement and `tickRunEnergy()`.
   * Mutations (e.g. runEnergyDelta) are applied immediately; later hooks see the updated state.
   * A returned fail condition stops the tick entirely (no further processing). Runs after
   * encounter commands and before this tick's input band, so a `ctx.lockPlayerActionsUntil` here
   * already drops this tick's inputs.
   */
  onTickStart?(ctx: EncounterPlayerLockContext): HookResult;
  /**
   * Called after damage is applied to the player (combat or environmental).
   * Runs AFTER `onTickStart` but BEFORE `tickRunEnergy()` in the same tick.
   * Mutations are applied immediately. A returned fail condition always applies
   * (not gated by infiniteHealth — contract failures are independent of HP immortality).
   */
  onPlayerDamageTaken?(info: EncounterPlayerDamageInfo, ctx: EncounterPlayerLockContext): HookResult;
}

/** Clickable equipment-panel slots, including ammunition stored outside PlayerEquipment. */
export type EquipmentClickSlot = EquipmentSlot | 'ammo' | 'quiver-ammo';

export interface EncounterInputState {
  /** Equipment slots the player clicked this tick (e.g. for grapple parry). */
  equipmentSlotClicks: readonly EquipmentClickSlot[];
}

/**
 * The encounter answers whether it claims an interaction so generic UI does not inspect
 * encounter-specific state or use replay data as a command-routing API.
 */
export type EncounterInput = { readonly kind: 'equipmentSlotClick'; readonly slot: EquipmentClickSlot };

export interface NpcMovementRequest {
  npcId: string;
  /** Ordered step tiles taken this tick; the encounter decides max speed. */
  path: Coordinate[];
  /** Only one adjacent step is accepted; its visual segment lasts two ticks. */
  movementSpeed?: 'crawl';
}

export interface NpcMovementInfo {
  npcId: string;
  from: Coordinate;
  to: Coordinate;
  path: Coordinate[];
  moved: boolean;
}

export interface EncounterContext {
  tick: number;
  /** Pre-player-move for NPC phases; final player coordinate for processPostTick. */
  playerPos: Coordinate;
  /** Note: Readonly<> is shallow — WorldState internals (Maps, arrays, actors) remain mutable. */
  world: Readonly<WorldState>;
  tickEvents: TickEvents;
  logEvent: (event: SimulationEvent) => void;
  /**
   * Grant a one-shot "next attack is `ticks` ticks faster" bonus to an actor. Clamped per
   * cooldown window; repeated triggers before the next swing do not stack.
   *
   * Wired by SimulationEngine to `CombatSystem.speedUpNextAttack`.
   */
  grantNextAttackSpeedup: (actorId: string, ticks: number) => void;
  /**
   * Register a dynamically spawned NPC (a Zuk set, a Yama void flare).
   *
   * Owns the engine-side invariants: inserting into the actor map and seeding movement history
   * at the current tick. THROWS on a duplicate id, which a bare `Map.set` would instead silently
   * replace while pending hits and attack cooldowns still referenced it.
   *
   * Timing: the NPC band walks the roster live in `processingOrder`, so an NPC spawned during it (by an
   * earlier NPC's hits, movement or action) takes its turn that same tick, after everyone registered
   * before it. One spawned in `completeNpcBand`, `processPostTick` or a command waits for the next tick.
   * Either way, targeting sees it at once.
   * The encounter still owns everything encounter-shaped: actor construction, id allocation,
   * `spawnTick`/`despawnTick`, initial target and cooldown, and its own spawn events.
   */
  spawnNpc: (actor: NpcActor) => void;
  /**
   * Remove an actor outright with NO death: it vanishes, matching OSRS `del`.
   *
   * Does not mark it dead, emit `actor_died`, play a death animation, or invoke
   * `onNpcDefeated` — the renderer distinguishes a missing actor (vanish) from `alive: false`
   * (death clip). Pending hits are deliberately left in the queue: they are dropped at their
   * impact tick when either actor is absent, so no damage lands either way, and leaving them
   * preserves the queue's existing resolution order.
   */
  despawnNpc: (npcId: ActorId) => void;
  /**
   * Deliver an NPC-sourced hit from outside its attacker's own action (a structure collapsing on
   * whatever stands beside it). No attack event; the hit joins the target's hit queue and lands at
   * `launch + impactDelayTicks` on the target's own turn: this tick if that turn is still to come,
   * otherwise the next. The attacker must be registered and alive.
   */
  queueNpcHit?: (attack: NpcAttackRequest) => void;
  /** Tick-local player inputs the encounter may react to (parry clicks, etc.). */
  inputs?: EncounterInputState;
  /** NPC movements applied so far this tick: empty in resolveHazards, complete by `completeNpcBand`. */
  npcMovements?: ReadonlyMap<string, NpcMovementInfo>;
  /** Force a protection-prayer change through the engine (e.g. a parry fail drops the overhead). */
  setProtectionPrayer?: (prayer: PrayerType | null) => void;
  /** Refuse protection-prayer activation before `untilTick` (exclusive); never shortens a lockout. */
  disableProtectionPrayersUntil?: (untilTick: number) => void;
  /**
   * Place the player on `position`, facing `facing` (OSRS angle), as a scripted teleport. Like the
   * game's forced-move primitive (RSMod `PathingEntityCommon.telemove` aborts the route and clears
   * the interaction), it ends the queued walk and the interaction: the player takes no step toward
   * this tick's walk target and `didLastTickDiscardWalkTarget` reports it, so the caller drops it;
   * a fresh click next tick walks again. The renderer snaps rather than slides. Inputs already
   * processed this tick, timers, prayers, the inventory and pending hits are untouched, and it
   * does not lock the player's actions. Call it before the player band (an NPC-band hook) so this
   * tick's player turn starts from the new tile.
   */
  teleportPlayer: (position: Coordinate, facing: number) => void;
  /**
   * Lock the player's actions until `unlockTick`, the first tick that accepts input again (absolute,
   * as {@link disableProtectionPrayersUntil}). Throws a RangeError unless it is a safe integer; one
   * at or before the current tick has already expired and does nothing. Otherwise the single lock
   * deadline extends (never shortens) and the interaction ends at once: the attack intent and any
   * pending pickup are cancelled and this tick's walk target is discarded
   * (`didLastTickDiscardWalkTarget`). Called at tick T, it means:
   *
   * - before input (`onTickStart`): T's queued inputs are dropped and the player takes no step;
   * - after input, before movement (an NPC-band hook, a hit landing): what the input already did
   *   (a prayer, a gear swap) stays, and the player takes no step;
   * - after movement (`processPostTick`): the step, its run energy and an attack already launched
   *   stand; only the walk target is reported discarded.
   *
   * Every later tick before `unlockTick` drops its queued inputs and takes no step. Timers, pending
   * hits and every NPC keep running. This is an action lock, stricter than the game's `p_delay`,
   * which only rejects NEW move clicks (RSMod `MoveGameClickHandler`, LostCityRS Engine-TS
   * `MoveClickHandler`) and lets a route accepted earlier continue; this also ends a walk in progress.
   */
  lockPlayerActionsUntil: (unlockTick: number) => void;
}

/**
 * What `Encounter.configureRunStart` may do to the unstarted world (tick 0 only): add or remove the
 * actors its run setup opens with, and put the player on that setup's start tile. Actors added here
 * are registered exactly as `createNpcs` ones are; removed ones vanish without an event, because
 * nothing has happened to them yet.
 */
export interface EncounterRunStartContext {
  readonly world: Readonly<WorldState>;
  readonly spawnNpc: (actor: NpcActor) => void;
  readonly despawnNpc: (npcId: ActorId) => void;
  /** Moves the player (and the run's recorded start) to `position`, as if the run had opened there. */
  readonly placePlayer: (position: Coordinate) => void;
}

export type EncounterCommandContext = Pick<
  EncounterContext,
  'playerPos' | 'tick' | 'world' | 'spawnNpc' | 'despawnNpc'
>;

export type EncounterCompletionOwnership = 'encounter-owned' | 'external-owned';

export interface EncounterNpcDefeat {
  readonly npcId: ActorId;
  readonly tick: number;
}

export type EncounterPlayerAttackInfo = Readonly<
  Pick<
    DamageAppliedInfo,
    'tick' | 'sourceId' | 'targetId' | 'attackType' | 'baseDamage' | 'effectiveDamage' | 'hpBefore' | 'hpAfter'
  >
>;

export interface EncounterPlayerAttackContext {
  readonly world: Readonly<WorldState>;
  readonly tickEvents: TickEvents;
  /**
   * Actor lifecycle, same semantics as on {@link EncounterContext}. An encounter may spawn or
   * remove actors in direct response to a player hit — Zuk's Jad HP threshold spawns its
   * Yt-HurKot the moment the landing hit crosses half health — so these hooks need them too.
   */
  readonly spawnNpc: EncounterContext['spawnNpc'];
  readonly despawnNpc: EncounterContext['despawnNpc'];
}

export interface EncounterPlayerAttackResolvedContext extends EncounterPlayerAttackContext {
  /** Request an engine-owned target-specific pause through an absolute resume tick. */
  readonly pausePlayerAutoAttack: (targetId: ActorId, resumeTick: number) => void;
}

export interface EncounterPlayerAttackStartedInfo {
  readonly tick: number;
  readonly sourceId: ActorId;
  readonly targetId: ActorId;
  readonly attackType: DamageType;
  readonly attackKind: AttackKind;
}

export interface NpcAttackRequest {
  readonly attackerId: ActorId;
  readonly targetId: ActorId;
  readonly style: DamageType;
  readonly attackKind: AttackKind;
  readonly rolledDamage: DamageValue;
  readonly accuracySucceeded: boolean;
  readonly impactDelayTicks: number;
  readonly applyPoison?: number;
  readonly prayerReduction?: PrayerReduction;
  /** Boost an ACCURATE roll, before prayer mitigation. See {@link AttackResolution.damageBonusPercent}. */
  readonly damageBonusPercent?: number;
  readonly damageCap?: AttackResolution['damageCap'];
  readonly isContinuation?: boolean;
  /**
   * Whether the hit still lands if this NPC dies or is removed before impact. Every producer
   * classifies its attacks explicitly; see {@link SourceDeathPolicy}.
   */
  readonly sourceDeathPolicy: SourceDeathPolicy;
  /**
   * When the protection-prayer check runs. Defaults to `'launch'`, which is OSRS
   * behavior for essentially every NPC: accuracy and prayer are both decided on the
   * tick the NPC attacks, and the projectile flight is only a visual delay. Use
   * `{ afterLaunchTicks: n }` for an attack whose animation precedes its release by `n`
   * ticks (JalTok-Jad), and `'impact'` only for a mechanic that genuinely resolves late.
   */
  readonly prayerCheckAt?: PrayerCheckTiming;
}

export interface EnvironmentalDamage {
  baseDamage: DamageValue;
  attackType: DamageType;
  source: FailCondition;
  prayerReduction?: PrayerReduction;
  playerPosition?: Coordinate;
  /** Ordinary poison/venom severity, applied through the engine's existing immunity/timer policy. */
  applyPoison?: number;
  /**
   * The hit switches protection prayers off and refuses them until this many ticks after it lands
   * ("You've been injured and can't use protection prayers!"). Captures of other bosses show the
   * prayer dropping on the hit tick, with the lockout length set per attack.
   */
  disablesProtectionPrayersForTicks?: number;
}

export interface EncounterTickResult {
  npcAttacks?: NpcAttackRequest[];
  environmentalDamages: EnvironmentalDamage[];
}

export interface EncounterCommandResult {
  readonly gameEvents?: readonly EmittableGameEvent[];
}

export interface MechanicsToggleInfo {
  key: string;
  label: string;
  /** The group title in the narrow Mobile Practice picker; desktop keeps the full label. */
  compactLabel?: string;
  /**
   * Where the configurer files this toggle. `player` is for things about the ACCOUNT rather than
   * the fight — permanent unlocks the player either has or has not earned — which belong beside
   * their stats rather than in a list of the boss's mechanics. `aid` is for practice conveniences
   * and cheats, which the settings UI groups together below the boss's real mechanics; without it
   * they are indistinguishable from the fight behavior a player came here to switch off, and
   * position alone cannot express it because the shared globals splice in around every encounter's
   * own list. Defaults to `mechanics`.
   */
  group?: 'mechanics' | 'aid' | 'player';
  /**
   * Keep this control with the essential setup choices rather than the separate practice aid group.
   * In-fight visibility is unchanged. Player-group controls stay beside combat stats.
   */
  setup?: boolean;
  /**
   * Render a segmented picker over these values instead of a checkbox, storing the chosen
   * `value` string under `key`. Present only for settings with more than two meaningful
   * states — a boolean pair belongs in a checkbox, which is one click rather than two.
   */
  choices?: readonly MechanicsChoice[];
  /**
   * Disable this control when its parent is off and appears in the same settings list.
   * Separate setup pickers stay editable for preselection without changing their parent.
   */
  dependsOn?: string;
  /**
   * Explanation, reachable from a marker beside the label. Keep it behind the marker rather than
   * rendering it inline as a caption: this list has to fit the Practice pane (150px at its
   * narrowest), where a caption per row is both the largest and the least read text on the surface.
   *
   * Segments color a run of it, for words the game itself shows in that color; the hint reads as
   * their plain concatenation.
   */
  info?: string | readonly MechanicsInfoSegment[];
  /**
   * When this control takes effect, for one that is live now but whose moment comes later in the
   * run: TzKal-Zuk's choices on an Inferno run that starts at wave 1. A few words at most, shown
   * as the row's own trailing note; return null once it applies and the row shows nothing.
   *
   * The control stays enabled either way. This is for settings that are DEFERRED, never for ones
   * that cannot apply — those belong disabled, with the reason beside them.
   *
   * The encounter owns both the rule and the words, so no generic component has to know which
   * boss a control belongs to; the settings UI only decides where the note sits.
   */
  appliesLater?: (context: MechanicsToggleContext) => string | null;
  /** Practice-only visibility, owned by the encounter. Hiding never changes the saved value. */
  visibleInPractice?: (context: MechanicsToggleContext) => boolean;
  /**
   * A named group of its own, for controls that belong to one part of the fight rather than to
   * the fight as a whole: TzKal-Zuk's on an Inferno run. The configurer and Practice list a
   * section after the boss's mechanics and before the aids, under this heading, whatever its
   * members' `setup` and `group` say. A deferral every member shares is stated once at the head
   * rather than on each row.
   */
  section?: string;
}

/** What a toggle's own rules may read about the run around it. */
export interface MechanicsToggleContext {
  /**
   * The editable (saved) settings: what the next run starts from, which may not have been applied
   * to the run in progress. Read it for choices and deferral notes, not for what the run is doing.
   */
  readonly config: Readonly<Partial<MechanicsConfig>>;
  /** The stage a run in progress is on, where the encounter publishes one. Absent before a run. */
  readonly stage?: number;
  /** The run's own published state, for rules about what it is doing. Absent before a fight. */
  readonly encounterSnapshot?: EncounterSnapshot;
}

export interface MechanicsInfoSegment {
  readonly text: string;
  readonly color?: string;
}

/**
 * Drawing the settings UI puts beside a choice's label. Encounters are plain TypeScript
 * and cannot carry the markup, so they name the drawing and the component owns it.
 */
export type MechanicsChoiceIcon = 'fireball-line-vertical' | 'fireball-line-horizontal' | 'left' | 'right';

export interface MechanicsChoice {
  value: string;
  /** Visible and accessible name; the optional drawing supplements it. */
  label: string;
  icon?: MechanicsChoiceIcon;
}

/**
 * `practice` actions change the fight (spawn, clear, reset); `inspection` actions only stage a
 * visual for looking at. The Mobile Practice tab lists inspection actions after practice ones, by
 * this field, never by label. Defaults to `practice`.
 */
export type DebugActionPurpose = 'practice' | 'inspection';

export interface DebugActionInfo {
  readonly command: EncounterCommand;
  readonly label: string;
  readonly purpose?: DebugActionPurpose;
  /** Restricts the Actions palette and Mobile Practice's action list, not the command route. */
  readonly visibleInPractice?: (context: MechanicsToggleContext) => boolean;
}

/**
 * `hp` is the exact HP the boss is set to when the preset is chosen.
 */
export interface BossHpPreset {
  label: string;
  hp: number;
  /** Optional tooltip spelling out what choosing this preset does (e.g. what it spawns). */
  hint?: string;
}

export interface DebugFlagInfo {
  key: string;
  label: string;
}

/**
 * The static control surface of one encounter kind: everything the settings UI, Practice and
 * debug overlay render for it. Lives on the manifest (`encounters/modules.ts`), keyed per
 * kind including variants, so the UI never instantiates a fight to draw a settings list.
 * `defaultMechanicsConfig` also backs the live `Encounter.getDefaultMechanicsConfig` —
 * implementations must delegate to the same builder, and `encounterModules.test.ts` fails
 * on drift between the two.
 */
export interface EncounterControls {
  readonly defaultMechanicsConfig: Readonly<Partial<MechanicsConfig>>;
  readonly mechanicsToggles: readonly MechanicsToggleInfo[];
  readonly debugActions: readonly DebugActionInfo[];
  readonly bossHpPresets?: readonly BossHpPreset[];
  readonly debugFlags?: readonly DebugFlagInfo[];
}

/** A fresh run an encounter offers in answer to one of its practice commands. */
export interface EncounterPracticeRestart {
  /**
   * The encounter seeds the restarted run opens with, chosen by the encounter (the Inferno's Retry:
   * this run's layout seed under a fresh attempt seed); omitted, the restart draws new ones. They are
   * the run's recorded seeds, so its replay rebuilds it exactly.
   */
  readonly encounterSeeds?: Readonly<Record<string, unknown>>;
  /**
   * Mechanics for the restarted run alone (e.g. a checkpoint's start wave), over the player's own.
   * Never saved: the recording keeps them, but the next plain restart uses the player's setup again.
   */
  readonly runMechanics: Readonly<Partial<MechanicsConfig>>;
  /**
   * Where the restarted run opens instead of the encounter's default start for its setup (e.g. the
   * tile the player restarted from). The engine records it as the run's start, so a replay opens there.
   */
  readonly startPosition?: Coordinate;
}

/** What a restart may read from the run it replaces. */
export interface EncounterRestartContext {
  /** The player's tile when the restart was asked for. */
  readonly playerPos: Coordinate;
}

export type { EncounterSnapshot, EncounterSnapshotContext } from './snapshot';
export type { EncounterVariant } from './variantTypes';

/** A run's landing intro: the player's opening facing and animation, before tick 0 runs. */
export interface EncounterIntroConfig {
  readonly facingAngle: number;
  readonly animationSeqId: number;
  /**
   * A game message for the landing, shown on the run's first tick: tick-0 events are never recorded,
   * so the chat, which reads the recording, would not show it any earlier.
   */
  readonly message?: string;
}

export interface Encounter {
  readonly kind: string;

  /** Where a fresh run opens, for the run setup in `mechanics` (an encounter may start stages apart). */
  getDefaultPlayerStart(mechanics: Readonly<Partial<MechanicsConfig>>): Coordinate;

  /**
   * The landing intro a fresh run with the setup in `mechanics` opens with, when the run enables
   * intros. When present, the engine applies facingAngle before the first tick and emits an
   * intro_started event with the animationSeqId. Read again on a tick-zero setup edit, which can
   * drop the run's intro (its message and facing) but never starts one (`SimulationEngine.reopenIntro`).
   */
  getIntroConfig(mechanics: Readonly<Partial<MechanicsConfig>>): EncounterIntroConfig | null;

  createNpcs(playerStart: Coordinate): NpcActor[];
  /**
   * Applies the run setup. Called while the world is built (before `createNpcs`, so that can open
   * the configured setup) and again on every tick-zero mechanics edit; `ctx` lets an edit that
   * changes the opening actors or start tile rebuild them. Must not advance time or randomness.
   */
  configureRunStart?(mechanics: Readonly<Partial<MechanicsConfig>>, ctx: EncounterRunStartContext): void;
  /**
   * The mechanics `configureRunStart` reads as the run's setup (a start wave, the shield's first side)
   * rather than as policy. A reconstructed run keeps its recorded values for these
   * (`SimulationEngine.keepRunStartSetup`), so a viewer's own setup cannot reconfigure its start.
   */
  readonly runStartMechanicsKeys?: readonly string[];
  getNpcDefinitions?(): NpcDefinitionCollection;
  reset(seeds?: Record<string, unknown>): void;
  getSeeds(): Record<string, unknown>;

  /**
   * Resolve hazards at start of tick, BEFORE player movement.
   * Checks use the player's pre-movement position (where they stood at end of last tick).
   */
  resolveHazards(ctx: EncounterContext, mechanicsEnabled: Partial<MechanicsConfig>): EnvironmentalDamage[];

  /*
   * The NPC band (`docs/architecture/npc-hit-queue-and-death.md`, section 2). After retaliation the
   * engine calls `prepareNpcBand` once, then runs each registered NPC's whole turn in
   * `processingOrder` — its incoming hits and timers (engine-owned), then, if it may still act,
   * `moveNpc`, `resolveNpcLocalEffects` and `processNpcTick` — and finally `completeNpcBand` once.
   * Every hook receives the start-of-tick player coordinate. Per-NPC work belongs in the per-actor
   * hooks. The band hooks hold encounter-wide work, plus the owner-sequenced turn an immediate boss
   * keeps by approval (Sol's attacks, beams and phases in `completeNpcBand`); they never repeat work a
   * per-actor hook does for the same NPC.
   *
   * Only movement defaults to the definition (`moveNpc` falls back to its `move`). Local effects and
   * actions run only where the encounter forwards them, because Sol and Yama already run some from
   * their own sequence (`completeNpcBand`, `resolveHazards`); a default would run those twice.
   */

  /** Encounter-wide work before any NPC's turn this tick (toggles, schedules that read no NPC damage). */
  prepareNpcBand?(ctx: EncounterContext, mechanicsEnabled: Partial<MechanicsConfig>): void;
  /**
   * First thing in each NPC's turn, in `processingOrder`: remove `actor` (`ctx.despawnNpc`) if its
   * removal is due. Removal is part of the removed NPC's own turn, so its tiles stay occupied for every
   * NPC whose turn came earlier this tick and are free for every later one (Inferno 1-68: Q t4119 and
   * Q t4180 corpses still block the lower-index mager, which moves the next tick; P t7687 a
   * higher-index bat enters a corpse's tiles on its removal tick). A removed NPC takes no turn.
   */
  removeNpcIfDue?(actor: NpcActor, ctx: EncounterContext, mechanicsEnabled: Partial<MechanicsConfig>): void;
  /**
   * This NPC's step for its turn; every request must be for `actor`. Applied by the engine as it is
   * yielded. Defaults to the actor's definition `move`.
   */
  moveNpc?(
    actor: NpcActor,
    ctx: EncounterContext,
    mechanicsEnabled: Partial<MechanicsConfig>,
  ): Iterable<NpcMovementRequest>;
  /** This NPC's local effects after it moves; returned damage is applied at once. */
  resolveNpcLocalEffects?(
    actor: NpcActor,
    ctx: EncounterContext,
    mechanicsEnabled: Partial<MechanicsConfig>,
  ): EnvironmentalDamage[];
  /**
   * This NPC's action. Every returned attack must name `actor` as its attacker. They are committed for this
   * instance through the combat system immediately, before the next NPC's turn (dropped if the hook removed
   * or replaced it), then returned damage is applied.
   */
  processNpcTick?(
    actor: NpcActor,
    ctx: EncounterContext,
    mechanicsEnabled: Partial<MechanicsConfig>,
  ): EncounterTickResult;
  /**
   * Encounter-wide work after every NPC's turn and before the player band: it sees every NPC's
   * damage, movement and attacks for the tick. Returned damage is applied at once.
   */
  completeNpcBand?(ctx: EncounterContext, mechanicsEnabled: Partial<MechanicsConfig>): EnvironmentalDamage[];

  /**
   * Run post-player encounter work after the FIFO pending-hit pass, movement, and autoattack.
   * Receives the final player coordinate; returned damage is applied immediately.
   */
  processPostTick(ctx: EncounterContext, mechanicsEnabled: Partial<MechanicsConfig>): EnvironmentalDamage[];

  onNpcDefeated?(defeat: EncounterNpcDefeat, ctx: EncounterContext, ownership: EncounterCompletionOwnership): void;
  /**
   * Called synchronously when a player attack resolves against an encounter NPC.
   * Target HP and alive state have already been mutated, and `hit_applied` and
   * `hitsplat_spawned` have already been emitted, so a hitsplat this hook emits renders
   * after the one for the hit itself. Immediate attacks invoke this during `processAttack`;
   * delayed attacks invoke it during the pending-hit pass. Both run before `processPostTick`.
   * Player combat-supply state in `ctx.world` is not guaranteed to be consistent
   * between these paths: immediate hits may run before launch-time consumption,
   * while delayed and later same-tick hits run after it. Do not rely on combat-supply
   * state from this hook.
   */
  onPlayerAttackResolved?(info: EncounterPlayerAttackInfo, ctx: EncounterPlayerAttackResolvedContext): void;
  onPlayerAttackStarted?(info: EncounterPlayerAttackStartedInfo, ctx: EncounterPlayerAttackContext): void;

  /**
   * A pure query, asked synchronously at click time. It must NOT queue anything: the caller still
   * routes the accepted input through the engine's normal input-lag + replay-recording path, so
   * that a replay reproduces the click exactly.
   */
  acceptsInput?(input: EncounterInput): boolean;

  getSnapshot(ctx: EncounterSnapshotContext): EncounterSnapshot;
  getOutcome(): EncounterOutcome;
  /**
   * The engine merges player-set mechanics over these defaults. Delegate to the same
   * builder that feeds the manifest's {@link EncounterControls} — a hand-rolled copy
   * here drifts from the settings UI, and `encounterModules.test.ts` fails on it.
   */
  getDefaultMechanicsConfig(): Partial<MechanicsConfig>;
  getArenaConfig(): ArenaConfig;
  /**
   * Called whenever the engine installs this encounter's arena (construction, reset, cache resolution)
   * with the config it is about to install; the return value is installed instead. An encounter whose
   * collision changes mid-run (destructible scenery) keeps `base` and reinstalls a refined copy through
   * `setArenaConfig` when that state changes, so a later reinstall from the engine cannot undo it.
   */
  refineArenaConfig?(base: ArenaConfig): ArenaConfig;
  /** Label for NPC-sourced damage in damage history and event logs (e.g. 'YamaAttack'). */
  getNpcDamageSourceLabel(sourceId?: string): string;

  executeCommand?(
    command: EncounterCommand,
    ctx: EncounterCommandContext,
    mechanics: Readonly<Partial<MechanicsConfig>>,
  ): EncounterCommandResult | undefined;

  /**
   * Practice: answer one of this encounter's commands with a fresh run (tick 0, a fresh loadout)
   * instead of an in-run effect, e.g. retrying the current wave. A pure query asked before the command
   * would be queued; the caller performs the restart. Undefined for every in-run command.
   * `mechanics` is the setup the restarted run applies `runMechanics` over: the player's own, not
   * this run's overrides.
   */
  planPracticeRestart?(
    command: EncounterCommand,
    mechanics: Readonly<Partial<MechanicsConfig>>,
    ctx: EncounterRestartContext,
  ): EncounterPracticeRestart | undefined;

  /**
   * Where a plain restart (Restart fight: a fresh run of the player's own setup, `mechanics`) opens
   * instead of {@link getDefaultPlayerStart}; undefined for the default. A pure query about the run
   * being replaced, asked before the restart; the engine records the answer as the run's start.
   */
  planRestartStart?(
    mechanics: Readonly<Partial<MechanicsConfig>>,
    ctx: EncounterRestartContext,
  ): Coordinate | undefined;

  /**
   * Practice tool: called after the engine directly sets the boss's HP so an
   * encounter that owns HP-driven state can snap that state
   * to match the new HP atomically, instead of cascading through transitions.
   * State only — dragging the health slider must never spawn or remove actors.
   */
  syncBossHp?(hp: number, ctx: Pick<EncounterContext, 'world'>): void;
  /**
   * Practice tool: called INSTEAD of a plain HP set when the player picks a named
   * preset from the manifest's {@link EncounterControls.bossHpPresets}. A preset is a
   * FIXED phase: the encounter rebuilds that phase's actors from scratch, so picking
   * the same chip twice always lands on the same fight state regardless of what was on
   * the floor beforehand. Omit it and a preset behaves like any other HP set.
   */
  enterBossHpPhase?(hp: number, ctx: Pick<EncounterContext, 'tick' | 'world' | 'spawnNpc' | 'despawnNpc'>): void;
  getEngineRules?(): EncounterEngineRules | undefined;
}
