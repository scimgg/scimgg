import type { ActorOutline } from '../core/actors/ActorBase';
import type { NpcSpawnOrigin } from '../core/actors/NpcActor';
import type { ActorId, DamageType } from '../core/actors/types';
import type { EncounterOutcome } from '../core/encounters/outcome';
import type { EncounterSnapshot } from '../core/encounters/snapshot';
import type { MechanicsToggleInfo } from '../core/encounters/types';
import type { PlayerEquipment } from '../rs/model/PlayerModelLoader';
import { DUKE_ALWAYS_BILE_KEY } from './duke';
import type { CombatSupplies } from './encounterLoadout';
import type { EquipmentStats } from './equipmentStats';
import type { GroundItem } from './groundItems';
import type { Inventory } from './inventory';
import type { CombatTimers, CooldownTrackState, PlayerStats, RunEnergyState, SpecialAttackState } from './playerState';

export interface MechanicsConfig {
  infiniteHealth: boolean;
  infiniteSpecialAttack?: boolean;
  autoPrepot?: boolean;
  waves?: boolean;
  fireballs?: boolean;
  yamaMageRange?: boolean;
  yamaMelee?: boolean;
  voidFlares?: boolean;
  /** Presentation only: the renderer reads it, the engine never does. */
  yamaStartGlyphs?: boolean;
  infiniteStamina?: boolean;
  zukAttacks?: boolean;
  zukSets?: boolean;
  zukJad?: boolean;
  zukHealers?: boolean;
  zukSetTimer?: boolean;
  zukShieldSafeTiles?: boolean;
  solHereditAttacks?: boolean;
  solHereditSand?: boolean;
  solHereditBeams?: boolean;
  solHereditTelegraph?: boolean;
  /** The Inferno: the start wave, '1'..'69' (a choice, so string-valued; 69 is TzKal-Zuk). */
  infernoStartWave?: string;
  infernoWestPillarDestroyed?: boolean;
  infernoSouthPillarDestroyed?: boolean;
  infernoNorthEastPillarDestroyed?: boolean;
  /** The Inferno: one wave's custom spawn layout (`serializeSpawnLayout`), '' for random spawns. */
  infernoSpawnLayout?: string;
  /** The Inferno: the practice start tile for waves 2-68, `"x,y"` local, '' for the default. */
  infernoStartTile?: string;
  /** The Inferno: the wave whose spawns a run keeps (Lock layout). A run override, never saved. */
  infernoPinnedWave?: string;
  /**
   * Death Charge pays out on two kills per cast instead of one. In OSRS this is the **rite of
   * vile transference**, a permanent account unlock rather than anything carried into the fight,
   * which is why it is a toggle and not an inventory item — but players call the result a double
   * death charge, so that is what the configurer says.
   */
  doubleDeathCharge?: boolean;
  upgradedPrayers?: boolean;
  zealPrayer?: boolean;
  /**
   * Encounter-specific mechanic entries (e.g. waves, fireballs). `string` carries the
   * multi-choice entries a checkbox cannot express, so narrowing this back to `boolean`
   * silently drops them. The record is persisted verbatim, so a stale or hand-edited
   * value arrives as an arbitrary string — narrow it with a guard, never cast.
   */
  [key: string]: boolean | string | undefined;
}

export const BOOLEAN_MECHANICS_KEYS = [
  'autoPrepot',
  'waves',
  'fireballs',
  'yamaMageRange',
  'yamaMelee',
  'voidFlares',
  'infiniteStamina',
  'infiniteHealth',
  'infiniteSpecialAttack',
  'doubleDeathCharge',
  'upgradedPrayers',
  'zealPrayer',
  'zukAttacks',
  'zukSets',
  'zukJad',
  'zukHealers',
  'zukSetTimer',
  'zukShieldSafeTiles',
  'solHereditAttacks',
  'solHereditSand',
  'solHereditBeams',
  'solHereditTelegraph',
  'infernoWestPillarDestroyed',
  'infernoSouthPillarDestroyed',
  'infernoNorthEastPillarDestroyed',
  'yamaStartGlyphs',
  DUKE_ALWAYS_BILE_KEY,
] as const;

export const BOOLEAN_MECHANICS_KEY_SET: ReadonlySet<string> = new Set(BOOLEAN_MECHANICS_KEYS);

export const DEFAULT_MECHANICS_CONFIG: MechanicsConfig = {
  infiniteHealth: false,
  infiniteSpecialAttack: false,
  autoPrepot: true,
  // On by default for the same reason the prayer book treats its unlock scrolls as earned: this
  // simulator has no account-unlock state to model, so an unlock a player would have by the time
  // they are here is assumed rather than hidden behind a switch they must find.
  doubleDeathCharge: true,
  upgradedPrayers: true,
  zealPrayer: false,
  // On by default. Off, every player's inventory silently fills with empty vials.
  vialSmasher: true,
};

/** `group: 'aid'` files these below boss mechanics; listing them first keeps their internal order stable. */
export const GLOBAL_MECHANICS_TOGGLES: MechanicsToggleInfo[] = [
  {
    key: 'autoPrepot',
    label: 'Auto-Prepot',
    group: 'aid',
    setup: true,
    // Deliberately generic: naming Mark of Darkness, the only buff applyPrepotEffects casts
    // today, makes this string something to remember to edit when a second one is added.
    info: 'Also casts spell buffs your loadout allows, like Mark of Darkness.',
  },
];

/**
 * Global because Death Charge is castable in any encounter, so gating
 * the rite behind one boss's toggle list left every other encounter silently casting the
 * un-upgraded version with no way to say otherwise. `group: 'player'` keeps them out of the
 * in-fight mechanics panel and beside the player's stats instead.
 */
export const GLOBAL_PLAYER_TOGGLES: MechanicsToggleInfo[] = [
  { key: 'doubleDeathCharge', label: 'Double Death Charge', group: 'player' },
  {
    key: 'upgradedPrayers',
    label: 'Deadeye & Mystic Vigour',
    group: 'player',
    info: 'Replaces Eagle Eye and Mystic Might once your Prayer level allows.',
  },
  {
    key: 'zealPrayer',
    label: 'Zeal',
    group: 'player',
    info: 'Replaces Piety once your Prayer level allows (Fractured Archive reward).',
  },
  {
    key: 'vialSmasher',
    label: 'Vial Smasher',
    group: 'player',
    info: "Smashes the empty vial when you drink a potion's last dose.",
  },
];

/**
 * Bucket the player toggles persist under, alongside the per-encounter entries in the same
 * `mechanicsConfigPerEncounter` record.
 *
 * They cannot ride an encounter's own entry: the store is keyed by encounter kind, so switching
 * the rite off at Yama would leave it on at every other boss — the exact split this being an
 * account unlock rules out. Not a real encounter kind, so it can never collide with one.
 */
export const PLAYER_MECHANICS_KEY = '__player__';

export const PLAYER_MECHANICS_TOGGLE_KEYS: ReadonlySet<string> = new Set(
  GLOBAL_PLAYER_TOGGLES.map((toggle) => toggle.key),
);

export function mergeMechanicsConfig(
  encounterDefaults?: Partial<MechanicsConfig>,
  config?: Partial<MechanicsConfig>,
): MechanicsConfig {
  return {
    ...DEFAULT_MECHANICS_CONFIG,
    ...(encounterDefaults ?? {}),
    ...(config ?? {}),
  };
}

export type Coordinate = [number, number];
export type TileString = string;
export type TickNumber = number;

/**
 * Wall-clock duration of one OSRS game tick, in milliseconds. The simulation
 * is tick-based; this is the canonical tick->ms mapping used by replay playback
 * and tutorial demo-cursor timing (at 1x speed).
 */
export const OSRS_TICK_MS = 600;

export type NpcRole = 'boss' | 'minion' | 'npc';

/**
 * Absolute tick an NPC's next attack is scheduled for, plus the cadence that scheduled it.
 * Absent for anything that is not on an attack clock right now (no target, dead, or a
 * non-combat actor such as Zuk's shield).
 */
export interface NpcAttackTimer {
  readonly nextAttackTick: number;
  readonly attackSpeed: number;
}

/** An accepted adjacent step presented linearly over two ticks; authoritative position is `to`. */
export interface NpcCrawlMovement {
  readonly from: Coordinate;
  readonly to: Coordinate;
  readonly startTick: number;
}

export interface NpcSnapshot {
  id: string;
  npcTypeId: number;
  archetypeId: string;
  role: NpcRole;
  alive: boolean;
  position: Coordinate;
  previousPosition: Coordinate;
  /**
   * Every tile this NPC stepped through this tick, ending on `position`, when it took more than one
   * step. A one-step move is fully described by `previousPosition` -> `position`, so it is omitted.
   */
  movementPath?: Coordinate[];
  crawlMovement?: NpcCrawlMovement;
  facingAngle: number;
  /**
   * OSRS angle this NPC's facing is pinned to, when it is pinned at all (e.g. Zuk's
   * shield). Simulation fact - the renderer decides what to do with it.
   */
  lockedFacing?: number;
  /**
   * OSRS angle from this NPC's latest facing-relevant action. Independent of the live combat
   * target, and stable as actors move.
   */
  actionFacing?: number;
  /**
   * Without a locked or action orientation, an in-combat NPC faces its target,
   * not its footsteps. Null on the ticks an NPC that faces its steps while moving
   * (`NpcActor.facesStepsWhileMoving`) walks.
   */
  combatTargetId?: ActorId | null;
  readonly attackTimer?: NpcAttackTimer;
  size: number;
  hp: number;
  maxHp: number;
  outline?: ActorOutline;
  spawnTick?: TickNumber;
  despawnTick?: TickNumber;
  /** First tick the NPC can be targeted; before it, it is not clickable and shows no bars. */
  targetableFromTick?: TickNumber;
  /** Never targetable: not clickable for the actor's whole life (see `NpcActor.untargetable`). */
  untargetable?: true;
  /** The despawn timer bar completes this many ticks before `despawnTick`. */
  despawnTimerLeadTicks?: number;
  /** Health bar stays up while the NPC is targetable, not only after a hit. */
  alwaysShowHealthBar?: boolean;
  /** Hits show its health bar even while it is untargetable (see `NpcActor`). */
  healthBarWhenUntargetable?: boolean;
  /** `'practice'` when a practice aid spawned it; mechanic toggles do not hide those. */
  spawnOrigin?: NpcSpawnOrigin;
  /**
   * Why a dead NPC died, when its definition tells causes apart (e.g. `'detonated'`); unset for an
   * ordinary kill. Simulation fact - the render config may give a cause its own death clip.
   */
  deathCause?: string;
  /**
   * Tick a dead NPC's death animation starts, when its definition places it after the defeat tick
   * (`despawnTick`). Absent means it starts on defeat. Only published while the NPC is dead.
   */
  deathAnimationTick?: TickNumber;
}

export interface NpcState extends NpcSnapshot {
  history: Map<TickNumber, Coordinate>;
}

export interface SimulationState {
  currentTick: TickNumber;
  playerPosition: Coordinate;
  playerPreviousPosition: Coordinate;
  playerMovementPath: Coordinate[];
  playerFacingAngle: number;
  playerIsMoving: boolean;
  playerIsRunning: boolean;
  primaryNpcPosition: Coordinate;
  primaryNpcPreviousPosition: Coordinate;
  primaryNpcFacingAngle: number;
  primaryNpcSize: number;
  playerOutline?: ActorOutline;
  npcs: NpcState[];
  encounter: EncounterSnapshot;
  encounterOutcome: EncounterOutcome;
  isAlive: boolean;
  markOfDarknessActive: boolean;
  markOfDarknessTicksRemaining: number;
  activePrayer: PrayerType | null;
  /** Lit `boost` prayers ({@link PRAYER_CATEGORIES}); conflict-free, deduplicated and insertion-ordered. */
  boostPrayers: readonly PrayerType[];
  independentPrayers: readonly PrayerType[];
  failedCondition: FailCondition | null;
  playerHistory: Map<TickNumber, Coordinate>;
  primaryNpcHistory: Map<TickNumber, Coordinate>;
  playerHP: number;
  maxHP: number;
  poisonVarp: number;
  poisonTickCounter: number;
  damageHistory: DamageHistoryEntry[];
  eventLog: SimulationEvent[];
  stats: PlayerStats;
  specialAttack: SpecialAttackState;
  /**
   * Soulreaper axe soul stacks. Present only while there are any, so a run that never stacks the
   * axe has no such field and recordings without it still compare equal.
   */
  soulreaperStacks?: number;
  combatTimers: CombatTimers;
  inventory: Inventory;
  groundItems: readonly GroundItem[];
  isRunEnabled: boolean;
  isSpecialAttackActive: boolean;
  pendingSpecialAttackActive?: boolean;
  pendingSpecialAttackToggles: number;
  pendingProtectionPrayer: [boolean, PrayerType | null];
  /** The whole predicted boost SET, since one click can turn several conflicting prayers off. */
  pendingBoostPrayers: [boolean, readonly PrayerType[]];
  /** The whole predicted independent SET, because membership has no slot to replace. */
  pendingIndependentPrayers: [boolean, readonly PrayerType[]];
  /**
   * Whether the quick-prayer set is engaged (OSRS varbit 4103,
   * `QUICKPRAYER_ACTIVE`). Simulation-owned so that repeated orb clicks inside a
   * single tick each flip it, as repeated orb clicks do in game.
   */
  quickPrayersActive: boolean;
  runEnergy: RunEnergyState;
  equipmentStats: EquipmentStats;
  prayerState: PrayerState;
  playerEquipment: PlayerEquipment;
  playerCombatSupplies: CombatSupplies;
  cooldownTracks: CooldownTrackState;
  mechanicsConfig: MechanicsConfig;
  attackTarget: ActorId | null;
  /** The last NPC the player attacked, kept after `attackTarget` clears; null before any attack. */
  lastAttackTarget: ActorId | null;
  selectedAttackStyleIndex: number;
  playerAttackCooldown: number;
  /**
   * Absolute tick at which the player's next auto-attack is allowed.
   * Equals `currentTick + playerAttackCooldown` while on cooldown, equals
   * `currentTick` on the exact tick the cooldown becomes zero, and is strictly
   * less than `currentTick` after the player let the ready tick pass without
   * attacking. `-1` means the player has never attacked in this encounter.
   */
  playerNextAttackTick: number;
  /** Effective attack speed in TICKS for the equipped weapon + style. */
  playerAttackSpeed: number;
  introActive: boolean;
}

export interface FireballState {
  active: boolean;
  phaseIndex: number | null;
  centerPosition: Coordinate | null;
  angle: string | null;
  ticksIntoPhase: number;
}

export interface DamageHistoryEntry {
  tick: TickNumber;
  source: FailCondition;
  readonly sourceNpcTypeId?: number;
  targetId: string;
  baseDamage: number;
  attackType: DamageType;
  activePrayer: PrayerType | null;
  prayedCorrectly: boolean | null;
  effectiveDamage: number;
  hpBefore: number;
  hpAfter: number;
  playerPosition?: Coordinate;
  /** Expected damage for this attack cycle. Player attacks only. */
  expectedHit?: number;
}

export enum EventType {
  TICK_START = 'TICK_START',
  PLAYER_MOVE = 'PLAYER_MOVE',
  PRAYER_CHANGE = 'PRAYER_CHANGE',
  DAMAGE_TAKEN = 'DAMAGE_TAKEN',
  DEATH = 'DEATH',
  /** Logged by Yama's fireball runtime as a phase starts, on the tick of its `fireball_spawned` game event. */
  FIREBALL_SPAWN = 'FIREBALL_SPAWN',
}

export type SimulationEvent =
  | {
      tick: TickNumber;
      type: EventType.TICK_START;
      playerPosition: Coordinate;
    }
  | {
      tick: TickNumber;
      type: EventType.PLAYER_MOVE;
      from: Coordinate;
      to: Coordinate;
    }
  | {
      tick: TickNumber;
      type: EventType.PRAYER_CHANGE;
      from: PrayerType | null;
      to: PrayerType | null;
    }
  | {
      tick: TickNumber;
      type: EventType.DAMAGE_TAKEN;
      source: FailCondition;
      attackType: DamageType;
      baseDamage: number;
      effectiveDamage: number;
      prayedCorrectly: boolean | null;
      hpAfter: number;
    }
  | {
      tick: TickNumber;
      type: EventType.DEATH;
      cause: FailCondition;
    }
  | {
      tick: TickNumber;
      type: EventType.FIREBALL_SPAWN;
      phaseIndex: number;
      centerPosition: Coordinate;
      angle: string;
    }
  | {
      tick: TickNumber;
      type: string;
      [key: string]: unknown;
    };

export enum PrayerType {
  ProtectMagic = 'ProtectMagic',
  ProtectRange = 'ProtectRange',
  ProtectMelee = 'ProtectMelee',
  Redemption = 'Redemption',
  Augury = 'Augury',
  Rigour = 'Rigour',
  Piety = 'Piety',
  Zeal = 'Zeal',
  EagleEye = 'EagleEye',
  MysticMight = 'MysticMight',
  Deadeye = 'Deadeye',
  MysticVigour = 'MysticVigour',
  Preserve = 'Preserve',
  RapidRestore = 'RapidRestore',
  RapidHeal = 'RapidHeal',
  ThickSkin = 'ThickSkin',
  BurstOfStrength = 'BurstOfStrength',
  ClarityOfThought = 'ClarityOfThought',
  SharpEye = 'SharpEye',
  MysticWill = 'MysticWill',
  RockSkin = 'RockSkin',
  SuperhumanStrength = 'SuperhumanStrength',
  ImprovedReflexes = 'ImprovedReflexes',
  HawkEye = 'HawkEye',
  MysticLore = 'MysticLore',
  SteelSkin = 'SteelSkin',
  UltimateStrength = 'UltimateStrength',
  IncredibleReflexes = 'IncredibleReflexes',
  Chivalry = 'Chivalry',
}

/**
 * The rows of the wiki's conflict table. Lighting a prayer turns off every lit prayer it shares a
 * group with, and nothing else (https://oldschool.runescape.wiki/w/Prayer?oldid=15411470,
 * "Conflicting prayers").
 */
export type PrayerConflictGroup = 'overhead' | 'defence' | 'attack' | 'strength';

/** The ranged and magic lines span both offence rows. */
const OFFENCE_ROWS: readonly PrayerConflictGroup[] = ['attack', 'strength'];
/** Chivalry and the level 70+ prayers span the defence row and both offence rows. */
const DEFENCE_AND_OFFENCE_ROWS: readonly PrayerConflictGroup[] = ['defence', 'attack', 'strength'];

/**
 * Every prayer's conflict groups (https://oldschool.runescape.wiki/w/Prayer?oldid=15411470,
 * "Conflicting prayers"). The only owner of prayer exclusivity: the engine, the input resolver,
 * the quick-prayer setup and the book all ask {@link prayersConflict}.
 */
export const PRAYER_CONFLICT_GROUPS: Readonly<Record<PrayerType, readonly PrayerConflictGroup[]>> = {
  [PrayerType.ProtectMagic]: ['overhead'],
  [PrayerType.ProtectRange]: ['overhead'],
  [PrayerType.ProtectMelee]: ['overhead'],
  // Redemption shares the overhead group with the Protect prayers (RuneLite `HeadIcon.REDEMPTION`),
  // so it belongs in that slot. It grants no damage reduction: `didPrayCorrectly` matches only the
  // three Protect values, which is exactly what keeps this correct without a special case there.
  [PrayerType.Redemption]: ['overhead'],
  [PrayerType.ThickSkin]: ['defence'],
  [PrayerType.RockSkin]: ['defence'],
  [PrayerType.SteelSkin]: ['defence'],
  [PrayerType.BurstOfStrength]: ['strength'],
  [PrayerType.SuperhumanStrength]: ['strength'],
  [PrayerType.UltimateStrength]: ['strength'],
  [PrayerType.ClarityOfThought]: ['attack'],
  [PrayerType.ImprovedReflexes]: ['attack'],
  [PrayerType.IncredibleReflexes]: ['attack'],
  [PrayerType.SharpEye]: OFFENCE_ROWS,
  [PrayerType.HawkEye]: OFFENCE_ROWS,
  [PrayerType.EagleEye]: OFFENCE_ROWS,
  [PrayerType.MysticWill]: OFFENCE_ROWS,
  [PrayerType.MysticLore]: OFFENCE_ROWS,
  [PrayerType.MysticMight]: OFFENCE_ROWS,
  // These boost Defence too, yet stay out of the defence row: "Deadeye and Mystic Vigour boost
  // defence, but do not conflict with the three basic Defence prayers" (same table, footnote a;
  // https://oldschool.runescape.wiki/w/Deadeye?oldid=15222979).
  [PrayerType.Deadeye]: OFFENCE_ROWS,
  [PrayerType.MysticVigour]: OFFENCE_ROWS,
  [PrayerType.Chivalry]: DEFENCE_AND_OFFENCE_ROWS,
  [PrayerType.Piety]: DEFENCE_AND_OFFENCE_ROWS,
  [PrayerType.Zeal]: DEFENCE_AND_OFFENCE_ROWS,
  [PrayerType.Rigour]: DEFENCE_AND_OFFENCE_ROWS,
  [PrayerType.Augury]: DEFENCE_AND_OFFENCE_ROWS,
  // "The only prayers without conflicting prayers": Rapid Restore, Rapid Heal, Protect Item, Preserve.
  [PrayerType.Preserve]: [],
  [PrayerType.RapidRestore]: [],
  [PrayerType.RapidHeal]: [],
};

/** Whether lighting `a` turns `b` off. A prayer never conflicts with itself: clicking it again toggles it. */
export function prayersConflict(a: PrayerType, b: PrayerType): boolean {
  if (a === b) return false;
  const groups = PRAYER_CONFLICT_GROUPS[b];
  return PRAYER_CONFLICT_GROUPS[a].some((group) => groups.includes(group));
}

/**
 * Where a lit prayer is stored, derived from its conflict groups so storage cannot disagree with
 * exclusivity.
 *
 * - `protection`: the overhead group, held in the single `activePrayer` slot.
 * - `boost`: a prayer in the defence, attack or strength rows. Lit boosts live in a SET: Thick Skin,
 *   Burst of Strength and Clarity of Thought coexist, and one click can turn several off.
 * - `independent`: no group at all. They evict nothing and nothing evicts them. Kept apart from the
 *   boost set so recorded states keep their shape and order.
 */
export type PrayerCategory = 'protection' | 'boost' | 'independent';

function categoryOf(groups: readonly PrayerConflictGroup[]): PrayerCategory {
  if (groups.includes('overhead')) return 'protection';
  return groups.length > 0 ? 'boost' : 'independent';
}

/** Keyed by string so a persisted selection can be looked up before it is known to be a prayer. */
export const PRAYER_CATEGORIES: Readonly<Record<string, PrayerCategory>> = Object.fromEntries(
  Object.values(PrayerType).map((prayer) => [prayer, categoryOf(PRAYER_CONFLICT_GROUPS[prayer])]),
);

/** Whether a persisted string names a prayer this build models. */
export function isPrayerType(value: string): value is PrayerType {
  return Object.hasOwn(PRAYER_CATEGORIES, value);
}

export type PrayerUnlockKey = 'upgradedPrayers' | 'zealPrayer';
export type PrayerUnlocks = Partial<Pick<MechanicsConfig, PrayerUnlockKey>>;

/** The account-unlock toggle each upgrade prayer needs; a prayer absent here is always unlocked. */
const PRAYER_UNLOCK_KEYS: Partial<Record<PrayerType, PrayerUnlockKey>> = {
  [PrayerType.Deadeye]: 'upgradedPrayers',
  [PrayerType.MysticVigour]: 'upgradedPrayers',
  [PrayerType.Zeal]: 'zealPrayer',
};

/** An unset toggle takes its {@link DEFAULT_MECHANICS_CONFIG} value, so older states keep their default book. */
export function isPrayerUnlocked(prayer: PrayerType, unlocks: PrayerUnlocks): boolean {
  const key = PRAYER_UNLOCK_KEYS[prayer];
  return key === undefined || (unlocks[key] ?? DEFAULT_MECHANICS_CONFIG[key]) === true;
}

/**
 * Drain effects, per the Prayer table's "Drain effect" column
 * (https://oldschool.runescape.wiki/w/Prayer?oldid=15411470) unless cited otherwise.
 */
export const PRAYER_DRAIN_EFFECTS: Record<PrayerType, number> = {
  [PrayerType.ProtectMagic]: 12,
  [PrayerType.ProtectRange]: 12,
  [PrayerType.ProtectMelee]: 12,
  [PrayerType.Piety]: 24,
  [PrayerType.Zeal]: 24, // https://oldschool.runescape.wiki/w/Zeal
  [PrayerType.Rigour]: 24,
  [PrayerType.Augury]: 24,
  [PrayerType.EagleEye]: 12,
  [PrayerType.MysticMight]: 12,
  [PrayerType.Deadeye]: 12,
  [PrayerType.MysticVigour]: 12,
  [PrayerType.Redemption]: 6,
  [PrayerType.Preserve]: 2,
  // One point per 36 seconds at +0 prayer bonus (https://oldschool.runescape.wiki/w/Rapid_Restore?oldid=14872668).
  [PrayerType.RapidRestore]: 1,
  // One point per 18 seconds at +0 prayer bonus (https://oldschool.runescape.wiki/w/Rapid_Heal?oldid=14872669).
  [PrayerType.RapidHeal]: 2,
  [PrayerType.ThickSkin]: 1,
  [PrayerType.BurstOfStrength]: 1,
  [PrayerType.ClarityOfThought]: 1,
  [PrayerType.SharpEye]: 1,
  [PrayerType.MysticWill]: 1,
  [PrayerType.RockSkin]: 6,
  [PrayerType.SuperhumanStrength]: 6,
  [PrayerType.ImprovedReflexes]: 6,
  [PrayerType.HawkEye]: 6,
  [PrayerType.MysticLore]: 6,
  [PrayerType.SteelSkin]: 12,
  [PrayerType.UltimateStrength]: 12,
  [PrayerType.IncredibleReflexes]: 12,
  [PrayerType.Chivalry]: 12,
};

/**
 * Redemption heals `floor(basePrayerLevel * 0.25)` — BASE Prayer level, not the boosted level and
 * not the remaining prayer points. Source: OSRS Wiki rev 15148542 §Healing.
 */
export const REDEMPTION_HEAL_FRACTION = 0.25;

export interface PrayerBoostMultipliers {
  attack?: number;
  strength?: number;
  defence?: number;
  ranged?: number;
  rangedStrength?: number;
  magic?: number;
  magicDamage?: number;
}

/**
 * `magic` is magic attack AND magic defence together, as the wiki states them for the whole
 * magic line; `defence` is only the separate non-magic share. Splitting a prayer's "+18% Magic"
 * across both keys double-counts it.
 *
 * The tiered and Chivalry rows are the Prayer table's "Effect" column
 * (https://oldschool.runescape.wiki/w/Prayer?oldid=15411470).
 */
export const PRAYER_STAT_MULTIPLIERS: Partial<Record<PrayerType, PrayerBoostMultipliers>> = {
  [PrayerType.Piety]: { attack: 1.2, strength: 1.23, defence: 1.25 },
  // https://oldschool.runescape.wiki/w/Zeal
  [PrayerType.Zeal]: { attack: 1.25, strength: 1.28, defence: 1.25 },
  [PrayerType.Rigour]: { ranged: 1.2, rangedStrength: 1.23, defence: 1.25 },
  [PrayerType.Augury]: { magic: 1.25, defence: 1.25, magicDamage: 1.04 },
  [PrayerType.EagleEye]: { ranged: 1.15, rangedStrength: 1.15 },
  [PrayerType.MysticMight]: { magic: 1.15, magicDamage: 1.02 },
  [PrayerType.Deadeye]: { ranged: 1.18, rangedStrength: 1.18, defence: 1.05 },
  [PrayerType.MysticVigour]: { magic: 1.18, magicDamage: 1.03, defence: 1.05 },
  [PrayerType.ThickSkin]: { defence: 1.05 },
  [PrayerType.RockSkin]: { defence: 1.1 },
  [PrayerType.SteelSkin]: { defence: 1.15 },
  [PrayerType.BurstOfStrength]: { strength: 1.05 },
  [PrayerType.SuperhumanStrength]: { strength: 1.1 },
  [PrayerType.UltimateStrength]: { strength: 1.15 },
  [PrayerType.ClarityOfThought]: { attack: 1.05 },
  [PrayerType.ImprovedReflexes]: { attack: 1.1 },
  [PrayerType.IncredibleReflexes]: { attack: 1.15 },
  [PrayerType.SharpEye]: { ranged: 1.05, rangedStrength: 1.05 },
  [PrayerType.HawkEye]: { ranged: 1.1, rangedStrength: 1.1 },
  // Mystic Will boosts no magic damage; Mystic Lore adds 1%.
  [PrayerType.MysticWill]: { magic: 1.05 },
  [PrayerType.MysticLore]: { magic: 1.1, magicDamage: 1.01 },
  [PrayerType.Chivalry]: { attack: 1.15, strength: 1.18, defence: 1.2 },
};

export interface PrayerState {
  points: number;
  maxPoints: number;
  drainCounter: number;
  activePrayers: PrayerType[];
  /**
   * Prayers don't drain on their activation tick
   * (strict < comparison), which makes 1-tick prayer flicking
   * emerge naturally from the tick processing order.
   */
  prayerActivationTicks: Partial<Record<PrayerType, number>>;
}

export function createDefaultPrayerState(): PrayerState {
  return {
    points: 99,
    maxPoints: 99,
    drainCounter: 0,
    activePrayers: [],
    prayerActivationTicks: {},
  };
}

export type CoreFailCondition = 'PlayerAttack' | 'Death';
/** Extensible fail condition — encounters add their own string values. */
export type FailCondition = CoreFailCondition | (string & {});
