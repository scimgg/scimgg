import { describe, expect, it } from 'vitest';
import type { Inventory } from '../../types/inventory';
import type { CooldownTrackState } from '../../types/playerState';
import { PrayerType } from '../../types/simulation';
import {
  isPrayerOp,
  type PendingInputOp,
  type PendingPrayerProjectionInput,
  projectPendingPrayerInput,
} from '../inputOps';

/** Super restore (4). Restores prayer immediately via `restore_prayer_formula`. */
const SUPER_RESTORE_4 = 3024;
/** Saradomin brew (4). Heals and boosts, but puts no prayer points in. */
const SARADOMIN_BREW_4 = 6685;

const NO_COOLDOWNS: CooldownTrackState = { food: 0, potion: 0, combo_food: 0 };

function inventoryOf(...ids: number[]): Inventory {
  return ids.map((id) => ({ id })) as Inventory;
}

function projection(overrides: Partial<PendingPrayerProjectionInput> = {}): PendingPrayerProjectionInput {
  return {
    start: { protection: null, boost: [], independent: [], quickPrayersActive: false },
    hasPrayerPoints: false,
    ops: [],
    inventory: inventoryOf(SUPER_RESTORE_4),
    equipment: {},
    cooldownTracks: NO_COOLDOWNS,
    prayerLevel: 99,
    playerHp: 99,
    inputTick: 1,
    restoreRules: { allowed: true },
    ...overrides,
  };
}

const drinkFirstSlot: PendingInputOp = { type: 'use_item', inventoryIndex: 0 };
const prayMelee: PendingInputOp = { type: 'protection', prayer: PrayerType.ProtectMelee };

describe('isPrayerOp', () => {
  it('accepts the three prayer ops and nothing else', () => {
    expect(isPrayerOp(prayMelee)).toBe(true);
    expect(isPrayerOp({ type: 'boost', prayer: PrayerType.Piety })).toBe(true);
    expect(isPrayerOp({ type: 'quickPrayers', selections: [] })).toBe(true);
    expect(isPrayerOp(drinkFirstSlot)).toBe(false);
    expect(isPrayerOp({ type: 'run_toggle' })).toBe(false);
  });
});

describe('projectPendingPrayerInput', () => {
  it('activates a prayer clicked after a restore dose in the same tick', () => {
    // The whole point of the single FIFO: the activation guard reads the points the dose
    // just wrote. Filtering the queue down to prayer ops predicts the opposite.
    const outcome = projectPendingPrayerInput(projection({ ops: [drinkFirstSlot, prayMelee] }));

    expect(outcome.protection).toBe(PrayerType.ProtectMelee);
    expect(outcome.rejected).toEqual([]);
  });

  it('refuses a prayer clicked before the restore dose', () => {
    const outcome = projectPendingPrayerInput(projection({ ops: [prayMelee, drinkFirstSlot] }));

    expect(outcome.protection).toBeNull();
    expect(outcome.rejected).toEqual([PrayerType.ProtectMelee]);
  });

  it('leaves a prayer on when the player already had points', () => {
    const outcome = projectPendingPrayerInput(projection({ hasPrayerPoints: true, ops: [prayMelee] }));

    expect(outcome.protection).toBe(PrayerType.ProtectMelee);
  });

  it('does not credit a dose the encounter blocks', () => {
    const outcome = projectPendingPrayerInput(
      projection({ ops: [drinkFirstSlot, prayMelee], restoreRules: { allowed: false } }),
    );

    expect(outcome.protection).toBeNull();
    expect(outcome.rejected).toEqual([PrayerType.ProtectMelee]);
  });

  it('does not credit a dose a multiplier floors to nothing', () => {
    const outcome = projectPendingPrayerInput(
      projection({ ops: [drinkFirstSlot, prayMelee], restoreRules: { allowed: true, multiplier: 0 } }),
    );

    expect(outcome.protection).toBeNull();
  });

  it('does not credit a dose the potion cooldown will refuse', () => {
    const outcome = projectPendingPrayerInput(
      projection({
        ops: [drinkFirstSlot, prayMelee],
        // Queue drains on inputTick 1, and the potion track is busy until 5.
        cooldownTracks: { ...NO_COOLDOWNS, potion: 5 },
      }),
    );

    expect(outcome.protection).toBeNull();
  });

  it('does not credit a consumable that restores no prayer', () => {
    const outcome = projectPendingPrayerInput(
      projection({ inventory: inventoryOf(SARADOMIN_BREW_4), ops: [drinkFirstSlot, prayMelee] }),
    );

    expect(outcome.protection).toBeNull();
  });

  it('ignores ops that cannot move prayer points', () => {
    const outcome = projectPendingPrayerInput(
      projection({
        hasPrayerPoints: true,
        ops: [{ type: 'run_toggle' }, { type: 'special_attack_toggle' }, prayMelee],
      }),
    );

    expect(outcome.protection).toBe(PrayerType.ProtectMelee);
  });
});
