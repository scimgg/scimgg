import { getItemAction, type ITEM_ACTIONS } from '../data/itemEffects';
import { hasPrayerRestorationEnhancement, prayerRestoreAmount } from '../data/prayerRestoration';
import type { PlayerEquipment } from '../rs/model/PlayerModelLoader';
import type { Inventory } from '../types/inventory';
import type { CooldownTrackState } from '../types/playerState';
import type { PlayerActor } from './actors/PlayerActor';
import type { ActorId, QueuedDropAction, QueuedEquipmentAction, QueuedItemAction } from './actors/types';
import { applyCooldown, canUseAction, consumeItem } from './itemActions';
import {
  type PrayerActionStep,
  type PrayerInputOutcome,
  type PrayerInputState,
  type QueuedPrayerAction,
  resolvePrayerActionSteps,
} from './prayerInput';

/**
 * One client operation, as the server receives it.
 *
 * The engine holds these in a single FIFO because that is the only ordering a
 * real server has. rsmod decodes a tick's packets in arrival order and runs each
 * op inline as it is read (`PlayerInputProcess.readClientInput`). Nothing is
 * grouped by op type.
 *
 * That ordering is load-bearing, not incidental: at zero prayer points a
 * restore dose followed by a prayer click activates the prayer, because the
 * activation guard (kept, as in rsmod) reads the points the dose just
 * wrote. Splitting these into per-type phases silently decides that race by
 * phase order instead, which is the defect this union exists to prevent.
 */
export type PendingInputOp =
  | QueuedPrayerAction
  | QueuedEquipmentAction
  | QueuedItemAction
  | QueuedDropAction
  | { readonly type: 'special_attack_toggle' }
  | { readonly type: 'run_toggle' }
  | { readonly type: 'attack_target'; readonly targetId: ActorId | null; readonly manualCastSpell: string | null }
  | { readonly type: 'pickup_ground_item'; readonly groundItemId: string };

export function isPrayerOp(op: PendingInputOp): op is QueuedPrayerAction {
  return op.type === 'protection' || op.type === 'boost' || op.type === 'independent' || op.type === 'quickPrayers';
}

/** How the encounter treats prayer restoration, as `itemRestrictions` expresses it. */
export interface PrayerRestoreProjectionRules {
  readonly allowed: boolean;
  readonly multiplier?: number;
}

export interface PendingPrayerProjectionInput {
  readonly start: PrayerInputState;
  readonly hasPrayerPoints: boolean;
  readonly ops: readonly PendingInputOp[];
  readonly inventory: Inventory;
  readonly equipment: PlayerEquipment;
  readonly cooldownTracks: CooldownTrackState;
  readonly prayerLevel: number;
  readonly playerHp: number;
  /** The tick the queue will be DRAINED on, i.e. `world.tick + 1`, which is what gates cooldowns. */
  readonly inputTick: number;
  readonly restoreRules: PrayerRestoreProjectionRules;
}

/**
 * Predict what this tick's queued inputs will do to the lit prayers, walking the FIFO in
 * arrival order so a restore dose is seen by a prayer clicked after it.
 *
 * Filtering the queue down to prayer ops and asking `points > 0` once gets the headline case
 * backwards: at zero prayer, restore-then-pray predicts the prayer stays OFF while the engine
 * correctly turns it ON. The optimistic UI and the tick have to answer from the same walk.
 *
 * Only consumables are interpreted, because they are the only ops that can move prayer points
 * within a tick. A timed `prayer_regeneration` effect deliberately does NOT count: it is an
 * `EffectTimer` whose `startedTick` guard stops it granting a point on the tick it was drunk.
 */
export function projectPendingPrayerInput(input: PendingPrayerProjectionInput): PrayerInputOutcome {
  let hasPrayerPoints = input.hasPrayerPoints;
  let inventory = input.inventory;
  let cooldownTracks = input.cooldownTracks;
  let tracklessItemUsed = false;
  const steps: PrayerActionStep[] = [];

  for (const op of input.ops) {
    if (isPrayerOp(op)) {
      steps.push({ action: op, hasPrayerPoints });
      continue;
    }
    if (op.type !== 'use_item') continue;

    const item = inventory[op.inventoryIndex];
    if (!item) continue;
    const def = getItemAction(item.id, op.option);
    if (!def) continue;
    const { track, delayTicks } = def;
    const usesTrackCooldown = track !== undefined && delayTicks > 0;
    if (usesTrackCooldown && !canUseAction(cooldownTracks, track, input.inputTick)) continue;
    // The engine allows one TRACKLESS use per tick and nothing else gates them, so a projection
    // that let a double-click through would predict a second dose the tick never applies.
    if (track === undefined && tracklessItemUsed) continue;
    if (def.minHpToUse !== undefined && input.playerHp < def.minHpToUse) continue;

    if (!hasPrayerPoints && restoresPrayer(def.effects, input)) hasPrayerPoints = true;

    inventory = consumeItem(inventory, op.inventoryIndex, def.consume);
    if (usesTrackCooldown) {
      cooldownTracks = applyCooldown(cooldownTracks, track, input.inputTick, delayTicks);
    }
    tracklessItemUsed ||= track === undefined;
  }

  return resolvePrayerActionSteps(input.start, steps);
}

/** Whether these effects would put at least one prayer point in, under the encounter's rules. */
function restoresPrayer(
  effects: (typeof ITEM_ACTIONS)[number]['effects'],
  input: PendingPrayerProjectionInput,
): boolean {
  if (!input.restoreRules.allowed) return false;
  const enhanced = hasPrayerRestorationEnhancement({ equipment: input.equipment, inventory: input.inventory });
  const multiplier = input.restoreRules.multiplier ?? 1;
  for (const effect of effects) {
    const base =
      effect.op === 'restore_prayer_formula' ? prayerRestoreAmount(effect.formula, input.prayerLevel, enhanced) : 0;
    // A multiplier that floors the restore to zero must not enable a prayer.
    if (base > 0 && Math.floor(base * multiplier) > 0) return true;
  }
  return false;
}

/**
 * Gather a projection input from live actor state. Shared so the engine's own prediction and
 * the state snapshot the interface renders cannot drift apart.
 *
 * `worldTick` is the CURRENT tick; the queue drains on the next one, which is what gates
 * consumable cooldowns.
 */
export function buildPendingPrayerProjection(
  player: PlayerActor,
  worldTick: number,
  restoreRules: PrayerRestoreProjectionRules,
): PendingPrayerProjectionInput {
  return {
    start: {
      protection: player.activePrayer,
      boost: player.boostPrayers,
      independent: player.independentPrayers,
      quickPrayersActive: player.quickPrayersActive,
    },
    hasPrayerPoints: player.prayerState.points > 0,
    ops: player.pendingInputOps,
    inventory: player.inventory,
    equipment: player.equipment,
    cooldownTracks: player.cooldownTracks,
    prayerLevel: player.stats.prayer.max,
    playerHp: player.vitals.hp,
    inputTick: worldTick + 1,
    restoreRules,
  };
}
