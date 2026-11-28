import {
  type ConsumePolicy,
  type CooldownTrack,
  type EffectOp,
  STAT_RESTORE_FORMULAS,
  type StatRestoreFormula,
} from '../data/itemEffects';
import { prayerRestoreAmount } from '../data/prayerRestoration';
import type { Inventory } from '../types/inventory';
import type {
  CombatTimers,
  CooldownTrackState,
  EffectTimer,
  PlayerStats,
  PoisonState,
  RunEnergyState,
  SpecialAttackState,
  TimedEffectType,
} from '../types/playerState';
import {
  COMBAT_SKILLS,
  clonePlayerStats,
  POISON_TICK_INTERVAL,
  RESTORABLE_STATS,
  SATURATED_HEART_COOLDOWN_TICKS,
  SATURATED_HEART_DURATION_TICKS,
  SURGE_POTION_COOLDOWN_TICKS,
} from '../types/playerState';
import type { PrayerState } from '../types/simulation';
import { boostStat, drainStat, lockStatDecay, restoreStat, withStatCurrent } from './statLevels';

/**
 * Consumption ordering: food → potion → combo_food
 * Rule: you cannot consume an item if ANY track to its RIGHT is on cooldown.
 */
const BLOCKED_BY_RIGHT: Record<CooldownTrack, CooldownTrack[]> = {
  food: ['potion', 'combo_food'],
  potion: ['combo_food'],
  combo_food: [],
};

/** Pure: returns a new inventory array, never mutates inputs. */
export function consumeItem(inventory: Inventory, index: number, policy: ConsumePolicy): Inventory {
  const newInventory = [...inventory];
  const currentSlot = newInventory[index];

  switch (policy.type) {
    case 'remove': {
      newInventory[index] = null;
      break;
    }

    case 'replace': {
      newInventory[index] = { id: policy.withId };
      break;
    }

    case 'none': {
      break;
    }

    case 'decrement': {
      if (currentSlot === null) {
        break;
      }
      const quantity = currentSlot.quantity ?? 1;
      if (quantity > 1) {
        newInventory[index] = { id: currentSlot.id, quantity: quantity - 1 };
      } else {
        newInventory[index] = null;
      }
      break;
    }
  }

  return newInventory;
}

/**
 * Food+potion+combo_food in the same tick works, but potion→food is blocked (potion on
 * cooldown blocks food).
 */
export function canUseAction(cooldownTracks: CooldownTrackState, track: CooldownTrack, currentTick: number): boolean {
  if (currentTick < cooldownTracks[track]) return false;

  for (const blocker of BLOCKED_BY_RIGHT[track]) {
    if (currentTick < cooldownTracks[blocker]) return false;
  }

  return true;
}

/**
 * Sets the track's cooldown to an absolute tick value (currentTick + delayTicks).
 * Uses Math.max to never shorten an existing cooldown (monotonic writes).
 */
export function applyCooldown(
  cooldownTracks: CooldownTrackState,
  track: CooldownTrack,
  currentTick: number,
  delayTicks: number,
): CooldownTrackState {
  const newValue = currentTick + delayTicks;
  const existing = cooldownTracks[track];
  return {
    ...cooldownTracks,
    [track]: Math.max(existing, newValue),
  };
}

export interface ItemActionState {
  playerHP: number;
  maxHP: number;
  stats: PlayerStats;
  poisonState: PoisonState;
  prayerState: PrayerState;
  runEnergy: RunEnergyState;
  specialAttack: SpecialAttackState;
  combatTimers: CombatTimers;
  cooldownTracks: CooldownTrackState;
  activeEffects: EffectTimer[];
  currentTick: number;
}

/**
 * Whether OSRS refuses the item outright, keeping the dose and starting no cooldown. Only the surge
 * potion refuses so far: "You are still full of adrenaline" inside its five-minute cooldown, and
 * "Drinking this would have no effect" at full special attack energy (/w/Surge_potion).
 */
export function isItemActionRefused(effects: readonly EffectOp[], state: ItemActionState): boolean {
  return effects.some(
    (effect) =>
      (effect.op === 'surge' &&
        (state.combatTimers.surgePotionCooldownTicks > 0 || state.specialAttack.energy >= 100)) ||
      (effect.op === 'overload' && state.activeEffects.some((active) => active.type === 'overload')),
  );
}

export type ItemActionModifiers = {
  readonly healing?: number;
  readonly prayerRestore?: number;
  readonly blockOverheal?: boolean;
  readonly enhancedPrayerRestoration?: boolean;
  readonly ringOfEnduranceEquipped?: boolean;
  /** True when applied via tick-0 auto-prepot (suppresses Overload self-damage pulses). */
  readonly isPrepot?: boolean;
};

const VENOM_THRESHOLD = 1_000_000;
const VENOM_OFFSET = VENOM_THRESHOLD - 3;

function getVenomDamage(poisonVarp: number): number {
  return Math.min((poisonVarp - VENOM_OFFSET) * 2, 20);
}

function downgradeVenomToPoisonVarp(poisonVarp: number): number {
  // Convert venom damage to poison varp that produces the same hit.
  // Poison damage = ceil(varp / 5), so varp = damage * 5 gives exact match.
  return getVenomDamage(poisonVarp) * 5;
}

function handleHeal(state: ItemActionState, amount: number): ItemActionState {
  const cappedHeal = Math.min(state.maxHP, state.playerHP + amount);
  return {
    ...state,
    playerHP: Math.max(state.playerHP, cappedHeal),
  };
}

/**
 * Anglerfish-style heal formula: heals based on stat level and can overheal above maxHP.
 * OSRS wiki formula: floor(x/10) + 2*floor(x/25) + 5*floor(x/93) + 2
 *
 * The healingMultiplier (from encounter rules) scales the FINAL computed heal amount,
 * not just the baseAmount, so it reduces both the heal and the overheal cap.
 */
function handleHealFormula(
  state: ItemActionState,
  baseAmount: number,
  scaleStat?: keyof PlayerStats,
  healingMultiplier?: number,
  blockOverheal?: boolean,
): ItemActionState {
  const statToUse = scaleStat ?? 'hitpoints';
  const statLevel = state.stats[statToUse].max;
  const healFromLevel =
    Math.floor(statLevel / 10) + 2 * Math.floor(statLevel / 25) + 5 * Math.floor(statLevel / 93) + 2;
  const rawHealAmount = Math.max(healFromLevel, baseAmount);
  const healAmount = scaleAmount(rawHealAmount, healingMultiplier);
  const overhealCap = blockOverheal ? state.maxHP : state.maxHP + healAmount;
  const newHP = Math.min(overhealCap, state.playerHP + healAmount);

  return {
    ...state,
    playerHP: newHP,
  };
}

function handleOverheal(state: ItemActionState, amount: number, cap: number): ItemActionState {
  return {
    ...state,
    playerHP: Math.min(cap, state.playerHP + amount),
  };
}

function scaledStatAmount(level: number, percent: number, flat: number): number {
  return Math.floor(level * percent) + flat;
}

function handleDelayedHeal(
  state: ItemActionState,
  amount: number,
  delayTicks: number,
  group?: string,
): ItemActionState {
  const filteredEffects = group
    ? state.activeEffects.filter((effect) => effect.type !== 'delayed_heal' || effect.data.group !== group)
    : state.activeEffects;

  const newEffect: EffectTimer = {
    id: `delayed_heal_${state.currentTick}_${amount}_${delayTicks}`,
    type: 'delayed_heal',
    ticksRemaining: delayTicks,
    tickDuration: delayTicks,
    startedTick: state.currentTick,
    data: {
      amount,
      group,
    },
  };

  return {
    ...state,
    activeEffects: [...filteredEffects, newEffect],
  };
}

function handleBoost(state: ItemActionState, stat: keyof PlayerStats, amount: number): ItemActionState {
  const level = state.stats[stat];
  return { ...state, stats: withStatCurrent(state.stats, stat, boostStat(level.max, level.current, amount)) };
}

function handleDrain(state: ItemActionState, stat: keyof PlayerStats, amount: number): ItemActionState {
  return { ...state, stats: withStatCurrent(state.stats, stat, drainStat(state.stats[stat].current, amount)) };
}

function handleRestorePrayer(state: ItemActionState, amount: number): ItemActionState {
  const newPoints = Math.min(state.prayerState.maxPoints, state.prayerState.points + amount);

  return {
    ...state,
    prayerState: {
      ...state.prayerState,
      points: newPoints,
    },
  };
}

/**
 * Raises each drained {@link RESTORABLE_STATS} skill by its own `floor(B * percent) + flat`, capped
 * at base. Prayer points come back through the potion's separate `restore_prayer_formula`.
 */
function handleRestoreAllStats(state: ItemActionState, formula: StatRestoreFormula): ItemActionState {
  const { percent, flat } = STAT_RESTORE_FORMULAS[formula];
  let stats = state.stats;
  for (const skill of RESTORABLE_STATS) {
    const { current, max } = stats[skill];
    stats = withStatCurrent(stats, skill, restoreStat(max, current, scaledStatAmount(max, percent, flat)));
  }
  return { ...state, stats };
}

/**
 * Invigorate: Magic +`floor(0.10 * B) + 4`, with Magic's decay suspended for the five minutes
 * (https://oldschool.runescape.wiki/w/Saturated_heart?oldid=15304376). The cooldown is the only
 * gate: it is exactly as long as the lock and ticks alongside it, so the lock never outlives it.
 */
function handleSaturatedHeart(state: ItemActionState): ItemActionState {
  if (state.combatTimers.saturatedHeartCooldownTicks > 0) return state;
  const magic = state.stats.magic;
  return {
    ...state,
    stats: withStatCurrent(
      state.stats,
      'magic',
      boostStat(magic.max, magic.current, scaledStatAmount(magic.max, 0.1, 4)),
    ),
    combatTimers: {
      ...state.combatTimers,
      saturatedHeartCooldownTicks: SATURATED_HEART_COOLDOWN_TICKS,
      statDecayLocks: lockStatDecay(state.combatTimers.statDecayLocks, ['magic'], {
        ticksRemaining: SATURATED_HEART_DURATION_TICKS,
        source: 'saturated_heart',
      }),
    },
  };
}

function scaleAmount(amount: number, multiplier?: number): number {
  return multiplier === undefined ? amount : Math.floor(amount * multiplier);
}

function handleRestoreRun(state: ItemActionState, amount: number): ItemActionState {
  const RUN_ENERGY_MAX = 10000;
  return {
    ...state,
    runEnergy: {
      energy: Math.min(RUN_ENERGY_MAX, state.runEnergy.energy + amount),
    },
  };
}

function handleCurePoison(state: ItemActionState, immunityTicks: number): ItemActionState {
  // Convert game ticks to varp units: each varp unit = one 30-tick poison cycle
  const varpUnits = Math.ceil(immunityTicks / POISON_TICK_INTERVAL);
  // Reset tick counter so first immunity cycle is a full 30 ticks
  return {
    ...state,
    poisonState: {
      ...state.poisonState,
      poisonVarp: -varpUnits,
      poisonTickCounter: POISON_TICK_INTERVAL,
      startedTick: state.currentTick,
    },
  };
}

function handleReducePoison(state: ItemActionState, amount: number): ItemActionState {
  const { poisonVarp } = state.poisonState;
  if (poisonVarp < 0 || poisonVarp === 0) {
    return state;
  }

  const reducedVarp =
    poisonVarp >= VENOM_THRESHOLD
      ? Math.max(0, downgradeVenomToPoisonVarp(poisonVarp) - amount)
      : Math.max(0, poisonVarp - amount);

  return {
    ...state,
    poisonState: {
      ...state.poisonState,
      poisonVarp: reducedVarp,
    },
  };
}

function handleApplyTimedEffect(
  state: ItemActionState,
  effectType: TimedEffectType,
  durationTicks: number,
  ringExtended = false,
): ItemActionState {
  const newEffect: EffectTimer = {
    id: `${effectType}_${state.currentTick}`,
    type: effectType,
    ticksRemaining: durationTicks,
    tickDuration: durationTicks,
    startedTick: state.currentTick,
    ...(ringExtended ? { ringExtended: true } : {}),
  };
  const otherEffects = state.activeEffects.filter((effect) => effect.type !== effectType);

  return {
    ...state,
    activeEffects: [...otherEffects, newEffect],
  };
}

function handleSelfDamage(state: ItemActionState, amount: number): ItemActionState {
  // Self-damage tools (locator orb, rock cake, divine potion HP cost) floor at 1 HP.
  const newHP = Math.max(1, state.playerHP - amount);
  return {
    ...state,
    playerHP: newHP,
  };
}

export function applyEffectOp(op: EffectOp, state: ItemActionState, modifiers?: ItemActionModifiers): ItemActionState {
  switch (op.op) {
    case 'heal':
      return handleHeal(state, scaleAmount(op.amount, modifiers?.healing));

    case 'heal_formula':
      return handleHealFormula(state, op.baseAmount, op.scaleStat, modifiers?.healing, modifiers?.blockOverheal);

    case 'overheal': {
      const overhealAmount = scaleAmount(op.amount, modifiers?.healing);
      return handleOverheal(
        state,
        overhealAmount,
        modifiers?.blockOverheal ? state.maxHP : state.maxHP + overhealAmount,
      );
    }

    case 'overheal_formula': {
      const rawAmount = scaledStatAmount(state.stats[op.scaleStat].max, op.percent, op.flat);
      const amount = scaleAmount(rawAmount, modifiers?.healing);
      const cap = modifiers?.blockOverheal ? state.maxHP : state.maxHP + amount;
      return handleOverheal(state, amount, cap);
    }

    case 'delayed_heal':
      return handleDelayedHeal(state, scaleAmount(op.amount, modifiers?.healing), op.delayTicks, op.group);

    case 'boost_formula':
      return handleBoost(state, op.stat, scaledStatAmount(state.stats[op.scaleStat].max, op.percent, op.flat));

    case 'divine_decay_lock':
      return {
        ...state,
        combatTimers: {
          ...state.combatTimers,
          statDecayLocks: lockStatDecay(state.combatTimers.statDecayLocks, op.stats, {
            ticksRemaining: op.durationTicks,
            source: 'divine',
          }),
        },
      };

    case 'drain_formula':
      return handleDrain(state, op.stat, scaledStatAmount(state.stats[op.stat].current, op.percent, op.flat));

    case 'restore_prayer_formula': {
      const amount = prayerRestoreAmount(
        op.formula,
        state.stats.prayer.max,
        modifiers?.enhancedPrayerRestoration ?? false,
      );
      return handleRestorePrayer(state, scaleAmount(amount, modifiers?.prayerRestore));
    }

    case 'restore_all_stats':
      return handleRestoreAllStats(state, op.formula);

    case 'restore_run':
      return handleRestoreRun(state, op.amount);

    case 'surge':
      return {
        ...state,
        specialAttack: { ...state.specialAttack, energy: Math.min(100, state.specialAttack.energy + op.percent) },
        combatTimers: { ...state.combatTimers, surgePotionCooldownTicks: SURGE_POTION_COOLDOWN_TICKS },
      };

    case 'cure_poison': {
      const downgradedState =
        state.poisonState.poisonVarp >= VENOM_THRESHOLD
          ? {
              ...state,
              poisonState: {
                ...state.poisonState,
                poisonVarp: downgradeVenomToPoisonVarp(state.poisonState.poisonVarp),
              },
            }
          : state;
      return handleCurePoison(downgradedState, op.immunityTicks);
    }

    case 'reduce_poison':
      return handleReducePoison(state, op.amount);

    case 'saturated_heart':
      return handleSaturatedHeart(state);

    case 'apply_timed_effect': {
      const ringExtended = op.effectType === 'stamina' && modifiers?.ringOfEnduranceEquipped === true;
      return handleApplyTimedEffect(state, op.effectType, op.durationTicks * (ringExtended ? 2 : 1), ringExtended);
    }

    case 'overload': {
      let stats = state.stats;
      for (const skill of COMBAT_SKILLS) {
        const level = stats[skill];
        stats = withStatCurrent(
          stats,
          skill,
          boostStat(level.max, level.current, scaledStatAmount(level.max, op.percent, op.flat)),
        );
      }
      const isPrepot = modifiers?.isPrepot === true;
      const afterDamage = isPrepot ? { ...state, stats } : handleSelfDamage({ ...state, stats }, op.selfDamagePerHit);
      const remainingHits = isPrepot ? 0 : Math.max(0, op.selfDamageHits - 1);
      const overloadTimer: EffectTimer = {
        id: `overload_${state.currentTick}`,
        type: 'overload',
        ticksRemaining: op.durationTicks,
        tickDuration: op.durationTicks,
        startedTick: state.currentTick,
        data: {
          percent: op.percent,
          flat: op.flat,
          pulseIntervalTicks: op.pulseIntervalTicks,
          selfDamageHitsRemaining: remainingHits,
          selfDamagePerHit: op.selfDamagePerHit,
          selfDamageIntervalTicks: op.selfDamageIntervalTicks,
          nextSelfDamageTick: state.currentTick + op.selfDamageIntervalTicks,
          expiryHeal: op.expiryHeal,
        },
      };
      return {
        ...afterDamage,
        activeEffects: [...afterDamage.activeEffects.filter((effect) => effect.type !== 'overload'), overloadTimer],
      };
    }

    case 'self_damage':
      return handleSelfDamage(state, op.amount);

    case 'self_damage_formula':
      return handleSelfDamage(state, scaledStatAmount(state.playerHP, op.percent, op.flat));

    default: {
      const _exhaustive: never = op;
      void _exhaustive;
      return state;
    }
  }
}

export function applyEffects(
  effects: readonly EffectOp[],
  state: ItemActionState,
  modifiers?: ItemActionModifiers,
): ItemActionState {
  let result = state;
  // https://oldschool.runescape.wiki/w/Ring_of_endurance: all stamina-family doses
  // restore twice the energy and last twice as long when consumed wearing the ring.
  const enhancedStamina =
    modifiers?.ringOfEnduranceEquipped &&
    effects.some((effect) => effect.op === 'apply_timed_effect' && effect.effectType === 'stamina');
  for (const effect of effects) {
    const resolved = enhancedStamina && effect.op === 'restore_run' ? { ...effect, amount: effect.amount * 2 } : effect;
    result = applyEffectOp(resolved, result, modifiers);
  }
  return syncVitalsToStats(result);
}

function syncVitalsToStats(state: ItemActionState): ItemActionState {
  if (state.playerHP === state.stats.hitpoints.current) {
    return state;
  }

  const newStats = clonePlayerStats(state.stats);
  newStats.hitpoints = {
    ...newStats.hitpoints,
    current: state.playerHP,
  };

  return {
    ...state,
    stats: newStats,
  };
}
