import type { CombatTimers, PoisonState, RunEnergyState, SpecialAttackState } from '../types/playerState';
import {
  DEATH_CHARGE_COOLDOWN_TICKS,
  DEATH_CHARGE_DURATION_TICKS,
  DEATH_CHARGE_PROCS,
  DEATH_CHARGE_PROCS_UPGRADED,
  DEATH_CHARGE_SPEC_RESTORE,
  MARK_OF_DARKNESS_COOLDOWN_TICKS,
  PRESERVE_QUALIFY_TICKS,
  RAPID_RESTORE_CYCLE_TICKS,
  RUN_ENERGY_MAX,
  SPEC_REGEN_AMOUNT,
  SPEC_REGEN_TICKS,
  SPEC_REGEN_TICKS_LIGHTBEARER,
} from '../types/playerState';
import type { PrayerState } from '../types/simulation';
import { PRAYER_DRAIN_EFFECTS, PrayerType } from '../types/simulation';
import type { EncounterPrayerDrainParams } from './encounters/types';
import { VENOM_THRESHOLD, venomDamage } from './poison';

const SPECIAL_ATTACK_MAX_ENERGY = 100;

function decrementTimer(ticks: number): number {
  return Math.max(0, ticks - 1);
}

function getSpecialRegenTicks(state: SpecialAttackState): number {
  return state.lightbearerEquipped ? SPEC_REGEN_TICKS_LIGHTBEARER : SPEC_REGEN_TICKS;
}

/**
 * Track whether the Lightbearer is worn, so the regen cadence above actually halves.
 *
 * The reset rule is the ring's own, and it is asymmetric: "Equipping the ring will cause the
 * special attack energy restoration timer to reset ONLY IF natural regeneration is below half.
 * Unequipping the ring will ALWAYS cause the restoration timer to reset" (wiki, Lightbearer).
 * `regenTickCounter` counts DOWN, so "below half" — less than half the natural cycle elapsed — is
 * a counter still above half. Equipping later than that keeps the progress and pays out at once,
 * which is the whole reason players swap the ring in mid-cycle.
 */
export function syncLightbearer(state: SpecialAttackState, equipped: boolean): SpecialAttackState {
  if (state.lightbearerEquipped === equipped) return state;
  if (!equipped) {
    return { ...state, lightbearerEquipped: false, regenTickCounter: SPEC_REGEN_TICKS };
  }
  const belowHalf = state.regenTickCounter > SPEC_REGEN_TICKS / 2;
  return {
    ...state,
    lightbearerEquipped: true,
    regenTickCounter: belowHalf ? SPEC_REGEN_TICKS_LIGHTBEARER : state.regenTickCounter,
  };
}

/**
 * Advance the special-attack regen cycle by one tick, adding 10% when it completes.
 *
 * `energyAtTickStart` is the bar BEFORE anything this tick spent from it, and it decides only one
 * thing: a full bar has no cycle to run, so the countdown starts when the bar first drops. Both
 * halves of that are read off `yama-contract-of-sensory-clouding-packet-data-1`, where the cycle
 * completes exactly 25 ticks after the spec that started it, not 24. Passing the POST-spend energy
 * instead lands every one of those a tick early, which is how the ordering is pinned: within a tick
 * the client evaluates this timer before the special is spent.
 *
 * A spec from a bar that was already partial does NOT restart the cycle.
 */
export function tickSpecialAttack(
  state: SpecialAttackState,
  energyAtTickStart: number = state.energy,
): SpecialAttackState {
  const regenTicks = getSpecialRegenTicks(state);
  if (energyAtTickStart >= SPECIAL_ATTACK_MAX_ENERGY) {
    return state.regenTickCounter === regenTicks ? state : { ...state, regenTickCounter: regenTicks };
  }

  const nextCounter = state.regenTickCounter - 1;

  if (nextCounter <= 0) {
    const nextEnergy = Math.min(SPECIAL_ATTACK_MAX_ENERGY, state.energy + SPEC_REGEN_AMOUNT);
    return {
      ...state,
      energy: nextEnergy,
      regenTickCounter: regenTicks,
    };
  }

  return {
    ...state,
    regenTickCounter: nextCounter,
  };
}

/**
 * Pin special attack energy to full. Backs the infinite-special-attack testing
 * toggle so the bar is always available and never drains.
 */
export function refillSpecialAttack(state: SpecialAttackState): SpecialAttackState {
  return { ...state, energy: SPECIAL_ATTACK_MAX_ENERGY };
}

export function calculateRunEnergyDrain(weight: number, agility: number): number {
  const clampedWeight = Math.max(0, Math.min(64, weight));
  // https://oldschool.runescape.wiki/w/Update:Run_Energy_Changes (8 January 2025):
  // two distinct floors; multiply integers before dividing to avoid 1 - agility/300 rounding.
  const base = Math.floor(60 + (67 * clampedWeight) / 64);
  return Math.floor((base * (300 - agility)) / 300);
}

/**
 * https://oldschool.runescape.wiki/w/Energy: `floor(agility / 10) + 15` from the current (boostable)
 * Agility level; the wiki gives `floor(1.3 * R)` for the full graceful set. Applying
 * `floor(R * (100 + pct) / 100)` to partial sets is our rounding assumption, not a sourced rule
 * (see `gracefulRegenBonusPercent` for per-piece percentages).
 */
export function calculateRunEnergyRegen(agility: number, gracefulBonusPercent = 0): number {
  const base = Math.floor(agility / 10) + 15;
  return Math.floor((base * (100 + gracefulBonusPercent)) / 100);
}

export interface RunEnergyTickContext {
  isRunning: boolean;
  agility: number;
  weight: number;
  gracefulBonusPercent?: number;
  staminaActive?: boolean;
  ringOfEnduranceEquipped?: boolean;
}

export function tickRunEnergy(state: RunEnergyState, context: RunEnergyTickContext): RunEnergyState {
  if (context.isRunning) {
    const baseDrain = calculateRunEnergyDrain(context.weight, context.agility);
    // https://oldschool.runescape.wiki/w/Energy and /w/Ring_of_endurance:
    // stamina wins; the ring's 15% reduction does not stack with it.
    const percent = context.staminaActive ? 30 : context.ringOfEnduranceEquipped ? 85 : 100;
    const drain = Math.floor((baseDrain * percent) / 100);
    const newEnergy = Math.max(0, state.energy - drain);
    return { energy: newEnergy };
  } else {
    const regen = calculateRunEnergyRegen(context.agility, context.gracefulBonusPercent);
    const newEnergy = Math.min(RUN_ENERGY_MAX, state.energy + regen);
    return { energy: newEnergy };
  }
}

/**
 * /w/Poison: an ordinary poison hit is `ceil(severity / 5)`, so severity 10 opens at 2 and the
 * displayed damage steps down once per five pulses as the severity counts off. Venom ramps on its
 * own schedule and deliberately does not come through here.
 */
export function ordinaryPoisonDamage(severity: number): number {
  return Math.ceil(severity / 5);
}

export function tickPoisonState(state: PoisonState): { state: PoisonState; damage: number } {
  if (state.poisonVarp === 0) {
    return { state: { ...state }, damage: 0 };
  }

  if (state.poisonVarp < 0) {
    return {
      state: {
        ...state,
        poisonVarp: Math.min(0, state.poisonVarp + 1),
      },
      damage: 0,
    };
  }

  if (state.poisonVarp >= VENOM_THRESHOLD) {
    const damage = venomDamage(state.poisonVarp);
    return {
      state: {
        ...state,
        poisonVarp: state.poisonVarp + 1,
      },
      damage,
    };
  }

  const damage = ordinaryPoisonDamage(state.poisonVarp);
  return {
    state: {
      ...state,
      poisonVarp: Math.max(0, state.poisonVarp - 1),
    },
    damage,
  };
}

export function tickCombatTimers(timers: CombatTimers): CombatTimers {
  return {
    ...timers,
    saturatedHeartCooldownTicks: decrementTimer(timers.saturatedHeartCooldownTicks),
    surgePotionCooldownTicks: decrementTimer(timers.surgePotionCooldownTicks),
    markOfDarknessCooldownTicks: decrementTimer(timers.markOfDarknessCooldownTicks),
    markOfDarknessActiveTicks: decrementTimer(timers.markOfDarknessActiveTicks),
    deathChargeCooldownTicks: decrementTimer(timers.deathChargeCooldownTicks),
    ...expireDeathCharge(timers),
  };
}

/** A Death Charge that runs out of window loses its unspent procs with it. */
function expireDeathCharge(
  timers: CombatTimers,
): Pick<CombatTimers, 'deathChargeActiveTicks' | 'deathChargeProcsRemaining'> {
  const deathChargeActiveTicks = decrementTimer(timers.deathChargeActiveTicks);
  return {
    deathChargeActiveTicks,
    deathChargeProcsRemaining: deathChargeActiveTicks === 0 ? 0 : timers.deathChargeProcsRemaining,
  };
}

/**
 * `upgraded` is the rite of vile transference: it buys a second payout from the same cast, not a
 * bigger one.
 */
export function castDeathCharge(timers: CombatTimers, upgraded: boolean): CombatTimers | null {
  if (timers.deathChargeCooldownTicks > 0) {
    return null;
  }
  return {
    ...timers,
    deathChargeCooldownTicks: DEATH_CHARGE_COOLDOWN_TICKS,
    deathChargeActiveTicks: DEATH_CHARGE_DURATION_TICKS,
    deathChargeProcsRemaining: upgraded ? DEATH_CHARGE_PROCS_UPGRADED : DEATH_CHARGE_PROCS,
  };
}

/**
 * Spend one Death Charge proc on a killing blow.
 *
 * The proc is spent even when the bar is already full: "Killing a monster while the player's
 * special attack bar is already at 100% will trigger the active effect of the spell without
 * actually restoring any special attack energy" (wiki, Death Charge). Crediting the energy first
 * and only then deciding whether a proc was used would hand the player a free extra kill.
 */
export function consumeDeathCharge(
  special: SpecialAttackState,
  timers: CombatTimers,
): { special: SpecialAttackState; timers: CombatTimers } | null {
  if (timers.deathChargeActiveTicks <= 0 || timers.deathChargeProcsRemaining <= 0) {
    return null;
  }
  const procsRemaining = timers.deathChargeProcsRemaining - 1;
  return {
    special: {
      ...special,
      energy: Math.min(SPECIAL_ATTACK_MAX_ENERGY, special.energy + DEATH_CHARGE_SPEC_RESTORE),
    },
    timers: {
      ...timers,
      deathChargeProcsRemaining: procsRemaining,
      deathChargeActiveTicks: procsRemaining === 0 ? 0 : timers.deathChargeActiveTicks,
    },
  };
}

export function castMarkOfDarkness(
  magicLevel: number,
  hasPurgingStaff: boolean,
  timers: CombatTimers,
): CombatTimers | null {
  if (timers.markOfDarknessCooldownTicks > 0) {
    return null;
  }

  const baseTicks = magicLevel * 3;
  const durationTicks = hasPurgingStaff ? baseTicks * 5 : baseTicks;

  return {
    ...timers,
    markOfDarknessCooldownTicks: MARK_OF_DARKNESS_COOLDOWN_TICKS,
    markOfDarknessActiveTicks: durationTicks,
  };
}

/**
 * Whether Preserve is lit AND has been lit long enough to extend this decay check.
 *
 * Reads the existing activation stamp rather than a second timer: `prayerActivationTicks` is
 * already reset by a genuine off/on flick, which is exactly the case the 25-tick gate exists to
 * catch, and it already survives replay because it is part of `PrayerState`.
 */
export function isPreserveQualified(state: PrayerState, currentTick: number): boolean {
  if (!state.activePrayers.includes(PrayerType.Preserve)) return false;
  const activationTick = state.prayerActivationTicks[PrayerType.Preserve];
  return activationTick !== undefined && currentTick - activationTick >= PRESERVE_QUALIFY_TICKS;
}

/**
 * Whether Rapid Restore's own +1 fires on `currentTick`: every 100 ticks counted from the tick it
 * was lit, independent of the normal recovery cycle. Like {@link isPreserveQualified} it reads the
 * activation stamp, so a genuine off/on flick re-phases it and a prayer that went dark (points ran
 * out earlier in the same timer band) does not fire.
 */
export function isRapidRestoreDue(state: PrayerState, currentTick: number): boolean {
  if (!state.activePrayers.includes(PrayerType.RapidRestore)) return false;
  const activationTick = state.prayerActivationTicks[PrayerType.RapidRestore];
  if (activationTick === undefined) return false;
  const elapsed = currentTick - activationTick;
  return elapsed > 0 && elapsed % RAPID_RESTORE_CYCLE_TICKS === 0;
}

export function useSpecialAttack(state: SpecialAttackState, energyCost: number): SpecialAttackState | null {
  if (state.energy < energyCost) {
    return null;
  }

  return {
    ...state,
    energy: state.energy - energyCost,
  };
}

export function tickPrayerDrain(
  state: PrayerState,
  prayerBonus: number,
  currentTick: number,
  encounterModifiers?: {
    drainMultiplier?: number;
    modifyDrainResistance?: (params: EncounterPrayerDrainParams) => number;
  },
): { state: PrayerState; drained: boolean } {
  if (state.activePrayers.length === 0 || state.points <= 0) {
    return { state, drained: false };
  }

  // OSRS mechanic: prayers don't drain on the tick they were activated.
  // This makes 1-tick prayer flicking emerge naturally.
  let totalDrainEffect = 0;
  for (const prayer of state.activePrayers) {
    const activationTick = state.prayerActivationTicks[prayer];
    if (activationTick !== undefined && activationTick >= currentTick) {
      continue;
    }
    totalDrainEffect += PRAYER_DRAIN_EFFECTS[prayer] ?? 0;
  }

  if (totalDrainEffect === 0) {
    return { state, drained: false };
  }

  if (encounterModifiers?.drainMultiplier != null) {
    totalDrainEffect = Math.floor(totalDrainEffect * encounterModifiers.drainMultiplier);
  }

  const drainResistance = encounterModifiers?.modifyDrainResistance
    ? encounterModifiers.modifyDrainResistance({
        totalDrainEffect,
        drainResistance: 2 * prayerBonus + 60,
        prayerBonus,
      })
    : 2 * prayerBonus + 60;
  let counter = state.drainCounter + totalDrainEffect;
  let points = state.points;

  while (counter >= drainResistance && points > 0) {
    points -= 1;
    counter -= drainResistance;
  }

  if (points <= 0) {
    return {
      state: { ...state, points: 0, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} },
      drained: true,
    };
  }

  return {
    state: { ...state, points, drainCounter: counter },
    drained: false,
  };
}
