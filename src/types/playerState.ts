export interface PlayerStats {
  attack: StatLevel;
  strength: StatLevel;
  defence: StatLevel;
  ranged: StatLevel;
  magic: StatLevel;
  prayer: StatLevel;
  hitpoints: StatLevel;
  agility: StatLevel;
}

export const PLAYER_STAT_KEYS = [
  'attack',
  'strength',
  'defence',
  'ranged',
  'magic',
  'prayer',
  'hitpoints',
  'agility',
] as const;

export type PlayerStatName = (typeof PLAYER_STAT_KEYS)[number];
export type PlayerBaseStats = Record<PlayerStatName, number>;

export function clampStatLevel(stat: PlayerStatName, level: number): number {
  const bounds = PLAYER_STAT_BOUNDS[stat];
  if (!Number.isFinite(level)) {
    return bounds.min;
  }
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(level)));
}

export const PLAYER_STAT_DISPLAY_NAMES: Record<PlayerStatName, string> = {
  attack: 'Attack',
  strength: 'Strength',
  defence: 'Defence',
  ranged: 'Ranged',
  magic: 'Magic',
  prayer: 'Prayer',
  hitpoints: 'Hitpoints',
  agility: 'Agility',
};

export const PLAYER_STAT_BOUNDS: Record<PlayerStatName, { readonly min: number; readonly max: number }> = {
  attack: { min: 1, max: 99 },
  strength: { min: 1, max: 99 },
  defence: { min: 1, max: 99 },
  ranged: { min: 1, max: 99 },
  magic: { min: 1, max: 99 },
  prayer: { min: 1, max: 99 },
  hitpoints: { min: 10, max: 99 },
  agility: { min: 1, max: 99 },
};

export function isValidBaseStatLevel(stat: PlayerStatName, level: unknown): level is number {
  const bounds = PLAYER_STAT_BOUNDS[stat];
  return typeof level === 'number' && Number.isInteger(level) && level >= bounds.min && level <= bounds.max;
}

/**
 * https://oldschool.runescape.wiki/w/Combat_level. Each `Math.floor` is its own rounding step:
 * collapsing `Math.floor(level / 2) + level` into `1.5 * level`, or dropping the floor on
 * `prayer / 2`, moves real accounts up a level.
 */
export function combatLevelFromBaseStats(stats: PlayerStats): number {
  const base = 0.25 * (stats.defence.max + stats.hitpoints.max + Math.floor(stats.prayer.max / 2));
  const melee = 0.325 * (stats.attack.max + stats.strength.max);
  const ranged = 0.325 * (Math.floor(stats.ranged.max / 2) + stats.ranged.max);
  const magic = 0.325 * (Math.floor(stats.magic.max / 2) + stats.magic.max);
  return Math.floor(base + Math.max(melee, ranged, magic));
}

export type CooldownTrackState = Record<'food' | 'potion' | 'combo_food', number>;

export interface StatLevel {
  current: number; // Can exceed max due to boosts
  max: number; // Base level (1-99)
}

export interface SpecialAttackState {
  energy: number; // 0-100
  regenTickCounter: number; // Ticks until next 10% regen (50 ticks = 30 seconds)
  lightbearerEquipped: boolean; // Doubles regen rate
}

export const RUN_ENERGY_MAX = 10000; // 10000 units = 100%

export interface RunEnergyState {
  energy: number;
}

export function createDefaultRunEnergy(): RunEnergyState {
  return { energy: RUN_ENERGY_MAX };
}

export const POISON_TICK_INTERVAL = 30;

export interface PoisonState {
  poisonVarp: number;
  poisonTickCounter: number;
  /**
   * Tick the current poison or immunity was applied on, or null. The timer skips the tick it
   * is recorded on, so the first cycle is the full {@link POISON_TICK_INTERVAL} — the same
   * guard, and for the same reason, as {@link EffectTimerBase.startedTick}. It matters only
   * while that tick is still running, so it is deliberately absent from `SimulationState`.
   */
  startedTick: number | null;
}

export function createDefaultPoisonState(): PoisonState {
  return { poisonVarp: 0, poisonTickCounter: POISON_TICK_INTERVAL, startedTick: null };
}

export type EffectType = 'saturated_heart' | 'delayed_heal' | 'overload' | 'preserve' | TimedEffectType;

export type TimedEffectType = 'stamina' | 'prayer_regeneration';

interface EffectTimerBase {
  id: string;
  ticksRemaining: number;
  tickDuration: number;
  /**
   * Tick the effect was created on. The timer pass skips effects started on the
   * tick it is running, mirroring a server timer: the timer records the tick it
   * was set on and only fires once `currentTick >= startedTick + interval`, so a
   * timer set by this tick's input never fires in this tick's timer stage.
   */
  startedTick: number;
}

export interface DelayedHealEffectTimer extends EffectTimerBase {
  type: 'delayed_heal';
  data: {
    amount: number;
    group?: string;
  };
}

export interface OverloadEffectTimer extends EffectTimerBase {
  type: 'overload';
  data: {
    percent: number;
    flat: number;
    pulseIntervalTicks: number;
    selfDamageHitsRemaining: number;
    selfDamagePerHit: number;
    selfDamageIntervalTicks: number;
    nextSelfDamageTick: number;
    expiryHeal: number;
  };
}

export interface StatusEffectTimer extends EffectTimerBase {
  type: Exclude<EffectType, 'delayed_heal' | 'overload'>;
  /** Stamina extended by the ring of endurance; cleared when ring removal halves the remaining time. */
  ringExtended?: boolean;
  data?: undefined;
}

export type EffectTimer = DelayedHealEffectTimer | OverloadEffectTimer | StatusEffectTimer;

/** The skills whose boosts naturally decay, and which decay locks cover. */
export const COMBAT_SKILLS = ['attack', 'strength', 'defence', 'ranged', 'magic'] as const;
export type CombatSkill = (typeof COMBAT_SKILLS)[number];

export type RestorableStat = Exclude<PlayerStatName, 'hitpoints' | 'prayer'>;

/**
 * Stats that restores and natural recovery raise back toward base: every stat except Hitpoints
 * (https://oldschool.runescape.wiki/w/Super_restore?oldid=15183989) and Prayer. Hitpoints has its
 * own regeneration, and the Prayer level is derived from prayer points, which come back through
 * their own restore path; raising the level here as well would double it.
 */
export const RESTORABLE_STATS: readonly RestorableStat[] = PLAYER_STAT_KEYS.filter(
  (stat): stat is RestorableStat => stat !== 'hitpoints' && stat !== 'prayer',
);

export type StatDecayLockSource = 'divine' | 'saturated_heart';

/**
 * Suspends the natural DECAY of one skill's boost; drains and recovery still apply. The source is
 * kept so the heart's expiry can announce itself and its infobox can find its own timer.
 */
export interface StatDecayLock {
  readonly ticksRemaining: number;
  readonly source: StatDecayLockSource;
}

export type StatDecayLocks = Readonly<Partial<Record<CombatSkill, StatDecayLock>>>;

export interface CombatTimers {
  saturatedHeartCooldownTicks: number; // 0 = can use (500 ticks = 5 min cooldown)
  /** Ticks until another surge potion dose may be drunk. */
  surgePotionCooldownTicks: number;
  markOfDarknessCooldownTicks: number;
  markOfDarknessActiveTicks: number;
  /** Ticks until Death Charge may be recast. */
  deathChargeCooldownTicks: number;
  /** Ticks the cast still has left to find a kill. */
  deathChargeActiveTicks: number;
  /** Kills the live cast can still pay out on: 1 normally, 2 with the rite. */
  deathChargeProcsRemaining: number;
  /** Next tick when boosts decay. Base 100-tick cycle, pushed out 50 once by a qualified Preserve. */
  statBoostDecayTick: number;
  /**
   * Whether a qualified Preserve has already postponed the boundary at `statBoostDecayTick`.
   * One extension per boundary — without the latch a lit Preserve would push the same drain out
   * forever instead of producing the documented 150-tick spacing.
   */
  statBoostDecayExtended: boolean;
  /** Next tick when drained skills recover by 1. A plain 100-tick cycle that Preserve never touches. */
  statRecoveryTick: number;
  /** Divine potions and the saturated heart. Replaced wholesale, never mutated in place. */
  statDecayLocks: StatDecayLocks;
  /**
   * Absolute tick on which natural Hitpoints change next fires, compared against the tick being
   * simulated (not the one being left, unlike the stat cycles above). See `tickNaturalHitpoints`.
   */
  hpRegenTick: number;
}

export interface PlayerCombatState {
  stats: PlayerStats;
  specialAttack: SpecialAttackState;
  timers: CombatTimers;
  activeEffects: EffectTimer[];
}

export const SPEC_REGEN_TICKS = 50; // 30 seconds
/** Percentage points restored per regen cycle. */
export const SPEC_REGEN_AMOUNT = 10;
export const SPEC_REGEN_TICKS_LIGHTBEARER = 25; // 15 seconds
export const SATURATED_HEART_DURATION_TICKS = 500; // 5 minutes
export const SATURATED_HEART_COOLDOWN_TICKS = 500; // 5 minutes
/** "can only be drunk once every five minutes" (/w/Surge_potion). */
export const SURGE_POTION_COOLDOWN_TICKS = 500;
export const MARK_OF_DARKNESS_COOLDOWN_TICKS = 10; // 6 seconds
export const STAT_DECAY_CYCLE_TICKS = 100; // 60 seconds
/** Drained skills recover 1 level per minute (https://oldschool.runescape.wiki/w/Stat_restoration?oldid=15153239). */
export const STAT_RECOVERY_CYCLE_TICKS = 100;
/**
 * "restore reduced stats every 60 seconds starting from the moment it is activated. Its timer is
 * completely independent from the normal timer" (https://oldschool.runescape.wiki/w/Rapid_Restore?oldid=14872668).
 */
export const RAPID_RESTORE_CYCLE_TICKS = 100;
/** Hitpoints move 1 toward max every minute (https://oldschool.runescape.wiki/w/Hitpoints?oldid=15337461). */
export const HP_REGEN_CYCLE_TICKS = 100;
/** "doubles the rate of Hitpoint regeneration" (https://oldschool.runescape.wiki/w/Rapid_Heal?oldid=14872669). */
export const HP_REGEN_RAPID_HEAL_CYCLE_TICKS = 50;
/**
 * First natural Hitpoints change. The stat cycles' deadline of 100 is compared against the tick
 * being left, so they first move levels on simulated tick 101; the HP deadline is compared against
 * the tick being simulated, so 101 gives it the same observable phase.
 */
export const HP_REGEN_FIRST_TICK = STAT_DECAY_CYCLE_TICKS + 1;
export const STAT_DECAY_CYCLE_PRESERVE_TICKS = 150; // 90 seconds with preserve
/**
 * How far a qualified Preserve pushes out a drain that is due now. The wiki frames the prayer as
 * extending an impending drain rather than only lengthening the following cycle: "if a player has a
 * boosted stat that would normally drain, Preserve will extend the time to drain by another 30
 * seconds" (rev 15227349). Applying it once per boundary is what yields the 150-tick spacing above.
 */
export const STAT_DECAY_PRESERVE_EXTENSION_TICKS = STAT_DECAY_CYCLE_PRESERVE_TICKS - STAT_DECAY_CYCLE_TICKS;
/**
 * How long Preserve must have been lit before it affects a decay check (OSRS Wiki rev 15227349).
 * Without this gate, flicking Preserve on just before the check would buy the full 50% extension.
 */
export const PRESERVE_QUALIFY_TICKS = 25;
export const DIVINE_POTION_DURATION_TICKS = 500; // 5 minutes
/** Overload (+): 5-minute duration, re-boosts every 15s (25 ticks), 5×10 HP hits every 2 ticks, heals 50 HP on expiry (/w/Overload_(+)). */
export const OVERLOAD_DURATION_TICKS = 500;
export const OVERLOAD_REBOOST_INTERVAL_TICKS = 25;
export const OVERLOAD_SELF_DAMAGE_HITS = 5;
export const OVERLOAD_SELF_DAMAGE_PER_HIT = 10;
export const OVERLOAD_SELF_DAMAGE_INTERVAL_TICKS = 2;
export const OVERLOAD_EXPIRY_HEAL = 50;
export const PURGING_STAFF_ITEM_ID = 29594;
export const LIGHTBEARER_ITEM_ID = 25975;
// https://oldschool.runescape.wiki/w/Ring_of_endurance: charges aren't modeled;
// the charged item ID represents >=500 charges, including its passive drain reduction.
export const RING_OF_ENDURANCE_ITEM_ID = 24736;

// Death Charge restores 15% special attack energy from kills within one minute and is castable every 60 seconds (wiki, Death Charge).
export const DEATH_CHARGE_DURATION_TICKS = 100;
export const DEATH_CHARGE_COOLDOWN_TICKS = 100;
export const DEATH_CHARGE_SPEC_RESTORE = 15;
/**
 * "the rite of vile transference... will permanently upgrade the Death Charge spell to restore
 * special attack energy from two targets per cast instead of one" (wiki, Rite of vile
 * transference). It changes the number of PROCS only — both variants restore 15% each.
 */
export const DEATH_CHARGE_PROCS = 1;
export const DEATH_CHARGE_PROCS_UPGRADED = 2;

export function createDefaultStats(): PlayerStats {
  const level99: StatLevel = { current: 99, max: 99 };
  return {
    attack: { ...level99 },
    strength: { ...level99 },
    defence: { ...level99 },
    ranged: { ...level99 },
    magic: { ...level99 },
    prayer: { ...level99 },
    hitpoints: { ...level99 },
    agility: { ...level99 },
  };
}

export function createStatsFromBaseLevels(levels: PlayerBaseStats): PlayerStats {
  return {
    attack: { current: levels.attack, max: levels.attack },
    strength: { current: levels.strength, max: levels.strength },
    defence: { current: levels.defence, max: levels.defence },
    ranged: { current: levels.ranged, max: levels.ranged },
    magic: { current: levels.magic, max: levels.magic },
    prayer: { current: levels.prayer, max: levels.prayer },
    hitpoints: { current: levels.hitpoints, max: levels.hitpoints },
    agility: { current: levels.agility, max: levels.agility },
  };
}

/** Clone live levels, preserving boosts and drains rather than resetting current to base. */
export function clonePlayerStats(stats: PlayerStats): PlayerStats {
  return {
    attack: { current: stats.attack.current, max: stats.attack.max },
    strength: { current: stats.strength.current, max: stats.strength.max },
    defence: { current: stats.defence.current, max: stats.defence.max },
    ranged: { current: stats.ranged.current, max: stats.ranged.max },
    magic: { current: stats.magic.current, max: stats.magic.max },
    prayer: { current: stats.prayer.current, max: stats.prayer.max },
    hitpoints: { current: stats.hitpoints.current, max: stats.hitpoints.max },
    agility: { current: stats.agility.current, max: stats.agility.max },
  };
}

export function cloneBaseStats(stats: PlayerStats): PlayerStats {
  return createStatsFromBaseLevels({
    attack: stats.attack.max,
    strength: stats.strength.max,
    defence: stats.defence.max,
    ranged: stats.ranged.max,
    magic: stats.magic.max,
    prayer: stats.prayer.max,
    hitpoints: stats.hitpoints.max,
    agility: stats.agility.max,
  });
}

export function createDefaultSpecialAttack(): SpecialAttackState {
  return {
    energy: 100,
    regenTickCounter: SPEC_REGEN_TICKS,
    lightbearerEquipped: false,
  };
}

export function createDefaultTimers(): CombatTimers {
  return {
    saturatedHeartCooldownTicks: 0,
    surgePotionCooldownTicks: 0,
    markOfDarknessCooldownTicks: 0,
    markOfDarknessActiveTicks: 0,
    deathChargeCooldownTicks: 0,
    deathChargeActiveTicks: 0,
    deathChargeProcsRemaining: 0,
    statBoostDecayTick: STAT_DECAY_CYCLE_TICKS,
    statBoostDecayExtended: false,
    // Same initial phase as the decay cycle, so the two only ever diverge through Preserve.
    statRecoveryTick: STAT_RECOVERY_CYCLE_TICKS,
    statDecayLocks: {},
    hpRegenTick: HP_REGEN_FIRST_TICK,
  };
}

export function createDefaultCombatState(): PlayerCombatState {
  return {
    stats: createDefaultStats(),
    specialAttack: createDefaultSpecialAttack(),
    timers: createDefaultTimers(),
    activeEffects: [],
  };
}
