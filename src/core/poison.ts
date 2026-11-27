/**
 * The rules for the player's poison counter. Poison, venom and both immunities share one number,
 * `PoisonState.poisonVarp`, as the game's single poison varp does:
 *
 * - `>= VENOM_THRESHOLD`: envenomed
 * - `1 .. VENOM_THRESHOLD - 1`: poisoned, at that severity
 * - `0`: neither, and no immunity
 * - `VENOM_IMMUNITY_CUTOFF .. -1`: immune to poison only
 * - `< VENOM_IMMUNITY_CUTOFF`: immune to poison and venom
 *
 * Immunity counts toward 0 one step per `POISON_TICK_INTERVAL` ticks (`tickPoisonState`). The step
 * clock runs while the counter is not 0, and changing the counter does not restart it: only a counter
 * leaving 0 starts a fresh clock (`restartsClock`). Private gameplay capture zulrah-packet-data-2.txt:
 * steps every 30 ticks from t2962 to t3172; envenoming at -37 on t3193 first stepped at t3202, and an
 * extended anti-venom+ sip on t3222 (venom to -59) next stepped at t3232, both on the same phase.
 */

import { VENOM_IMMUNE_HEAD_IDS } from '../data/venomImmunity';
import { POISON_TICK_INTERVAL, type PoisonState } from '../types/playerState';

/**
 * Severities at or above this are venom: 6 damage on the first hit, 2 more each hit, capped at 20
 * (https://oldschool.runescape.wiki/w/Venom). An attack or hazard envenoms by passing it as
 * `applyPoison`.
 */
export const VENOM_THRESHOLD = 1_000_000;
const VENOM_OFFSET = VENOM_THRESHOLD - 3;

/**
 * Immunity below this also blocks venom; from here up to -1 it blocks poison only. The game says
 * "Your venom resistance is about to wear off." stepping to -39 and "Your venom resistance has worn
 * off, but you are still resistant to poison." stepping to -38, and venom took at -37 (private
 * gameplay capture zulrah-packet-data-2.txt, t3112, t3142 and t3193). RuneLite
 * `runelite-client/src/main/java/net/runelite/client/plugins/timersandbuffs/TimersAndBuffsPlugin.java`
 * at `9af7b54deaac35b3153af06195d66c1d68fbea5a`: `VENOM_VALUE_CUTOFF = -38; // Antivenom < -38 <=
 * Antipoison < 0`, with `POISON_TICK_LENGTH = 30` per step.
 */
export const VENOM_IMMUNITY_CUTOFF = -38;

/** The next venom hit's damage, which a downgrade to poison keeps. */
export function venomDamage(poisonVarp: number): number {
  return Math.min((poisonVarp - VENOM_OFFSET) * 2, 20);
}

/** Ordinary poison hits `ceil(severity / 5)`, so five times the venom hit lands the same damage. */
function downgradeVenomToPoison(poisonVarp: number): number {
  return venomDamage(poisonVarp) * 5;
}

function isWearingVenomImmuneHead(headId: number | undefined): boolean {
  return headId !== undefined && VENOM_IMMUNE_HEAD_IDS.has(headId);
}

/**
 * Poison or envenom the player at `severity`, returning `state` itself when refused.
 *
 * Refused by a worn serpentine helm (or a recolor), which grants immunity but does not cure what is
 * already there (https://oldschool.runescape.wiki/w/Serpentine_helm); by any immunity for poison;
 * by venom immunity only for venom; and by existing venom. Poison does not stack: the greater
 * severity is kept, so venom upgrades a poison. Envenoming through poison-only immunity keeps the
 * running clock (`restartsClock`).
 */
export function applyPlayerPoison(
  state: PoisonState,
  severity: number,
  headId: number | undefined,
  tick: number,
): PoisonState {
  const current = state.poisonVarp;
  if (current >= VENOM_THRESHOLD || isWearingVenomImmuneHead(headId)) return state;
  const venom = severity >= VENOM_THRESHOLD;
  if (current < 0 && (!venom || current < VENOM_IMMUNITY_CUTOFF)) return state;

  return withPoisonVarp(state, Math.max(current, severity), tick);
}

/**
 * The step clock is stopped while the counter is 0, so a counter leaving 0 starts it with a full first
 * cycle: the timer band runs AFTER the hit or drink, so recording the tick stops it spending one of
 * those 30 on that tick itself. Any other change keeps the running clock's phase.
 */
function restartsClock(state: PoisonState): boolean {
  return state.poisonVarp === 0;
}

function withPoisonVarp(state: PoisonState, poisonVarp: number, tick: number): PoisonState {
  return {
    ...state,
    poisonVarp,
    ...(restartsClock(state) ? { poisonTickCounter: POISON_TICK_INTERVAL, startedTick: tick } : {}),
  };
}

/** Cure, and set `immunitySteps` of immunity without shortening a longer one already running. */
function grantImmunity(state: PoisonState, immunitySteps: number, tick: number): PoisonState {
  const poisonVarp = Math.min(state.poisonVarp, -immunitySteps);
  if (poisonVarp === state.poisonVarp) return state;
  return withPoisonVarp(state, poisonVarp, tick);
}

/**
 * Antipoisons (sanfew serum, antidote++): on venom they ONLY convert it to poison at the same damage
 * ("will convert the venom to regular poison, which starts at the same damage the venom had. To
 * fully cure venom, players can drink another dose of antipoison", https://oldschool.runescape.wiki/w/Venom);
 * otherwise they cure poison and grant poison immunity.
 */
export function cureWithAntipoison(state: PoisonState, immunitySteps: number, tick: number): PoisonState {
  if (state.poisonVarp >= VENOM_THRESHOLD) {
    return { ...state, poisonVarp: downgradeVenomToPoison(state.poisonVarp) };
  }
  return grantImmunity(state, immunitySteps, tick);
}

/** Anti-venoms "completely cure venom" (https://oldschool.runescape.wiki/w/Venom) and poison. */
export function cureWithAntivenom(state: PoisonState, immunitySteps: number, tick: number): PoisonState {
  return grantImmunity(state, immunitySteps, tick);
}

/**
 * Guthix rest: lowers the poison severity by `amount`, converting venom to poison first ("reduce
 * venom to poison", https://oldschool.runescape.wiki/w/Venom). No effect on immunity.
 */
export function reducePoison(state: PoisonState, amount: number): PoisonState {
  const { poisonVarp } = state;
  if (poisonVarp <= 0) return state;
  const severity = poisonVarp >= VENOM_THRESHOLD ? downgradeVenomToPoison(poisonVarp) : poisonVarp;
  return { ...state, poisonVarp: Math.max(0, severity - amount) };
}
