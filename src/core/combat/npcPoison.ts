import { clearNpcPoison, type NpcActor } from '../actors/NpcActor';
import type { ActorId } from '../actors/types';
import { ordinaryPoisonDamage } from '../timers';

/** /w/Poison: a poison pulse lands every 30 ticks (18 seconds). */
export const POISON_PERIOD_TICKS = 30;

/**
 * The wiki's `poison_resistance` monster field is a percentage, and only a full 100 makes a
 * target unpoisonable; nothing in OSRS partially resists ordinary poison, so the in-between
 * values this field can carry are treated as poisonable rather than invented into a scale.
 */
export function isImmuneToPoison(target: NpcActor): boolean {
  return (target.formulaStats?.poisonResistance ?? 0) >= 100;
}

export function canPoisonNpc(target: NpcActor): boolean {
  return target.alive && !isImmuneToPoison(target);
}

export interface ApplyNpcPoisonInput {
  readonly target: NpcActor;
  readonly sourceId: ActorId;
  readonly severity: number;
  readonly tick: number;
}

/**
 * /w/Poison: poison does not stack. A fresh application keeps the GREATER severity and restarts
 * the cadence only when the target was not already poisoned, so re-poisoning mid-cycle cannot
 * drag the next pulse forward. Same rule as the player's `applyPlayerPoison` in `core/poison.ts`.
 */
export function applyNpcPoison(input: ApplyNpcPoisonInput): boolean {
  const { target, severity, tick } = input;
  if (severity <= 0 || !canPoisonNpc(target)) return false;

  const existing = target.poison;
  target.poison = {
    sourceId: input.sourceId,
    severity: Math.max(existing?.severity ?? 0, severity),
    nextPulseTick: existing?.nextPulseTick ?? tick + POISON_PERIOD_TICKS,
  };
  return true;
}

export interface NpcPoisonPulse {
  readonly sourceId: ActorId;
  readonly damage: number;
}

/**
 * Resolves at most one pulse, then re-arms the clock. Severity is spent by the pulse it pays for,
 * so a poison on its last point still deals that point's damage before it clears.
 */
export function advanceNpcPoison(target: NpcActor, currentTick: number): NpcPoisonPulse | null {
  const poison = target.poison;
  if (poison === undefined) return null;
  if (!target.alive) {
    clearNpcPoison(target);
    return null;
  }
  if (poison.nextPulseTick > currentTick) return null;

  const pulse: NpcPoisonPulse = { sourceId: poison.sourceId, damage: ordinaryPoisonDamage(poison.severity) };
  const severity = poison.severity - 1;
  if (severity <= 0) {
    clearNpcPoison(target);
  } else {
    target.poison = { ...poison, severity, nextPulseTick: currentTick + POISON_PERIOD_TICKS };
  }
  return pulse;
}
