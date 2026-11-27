import { describe, expect, it } from 'vitest';
import { getPrepotEffects, ITEM_ACTIONS, isPrepottable } from '../../data/itemEffects';

function getItemAction(itemId: number) {
  const def = ITEM_ACTIONS[itemId];
  if (!def) {
    throw new Error(`Missing ITEM_ACTIONS definition for item ${itemId}`);
  }
  return def;
}

describe('isPrepottable', () => {
  it('returns true for items with boost, saturated heart, or timed-effect ops', () => {
    const prepottableIds = [27641, 12695, 23685, 31638, 27629, 10925, 5952];

    for (const itemId of prepottableIds) {
      expect(isPrepottable(getItemAction(itemId))).toBe(true);
    }
  });

  it('returns false for food, self-damage, restore-only, and no-effect items', () => {
    const nonPrepottableIds = [13441, 29143, 3144, 22081, 229];

    for (const itemId of nonPrepottableIds) {
      expect(isPrepottable(getItemAction(itemId))).toBe(false);
    }
  });
});

describe('getPrepotEffects', () => {
  it('keeps only boost effects from super combat', () => {
    const effects = getPrepotEffects(getItemAction(12695).effects);

    expect(effects).toHaveLength(3);
    expect(effects.every((effect) => effect.op === 'boost_formula')).toBe(true);
  });

  it('keeps saturated_heart effect from saturated heart', () => {
    const effects = getPrepotEffects(getItemAction(27641).effects);

    expect(effects).toEqual([{ op: 'saturated_heart' }]);
  });

  it('keeps boosts and the decay lock, but removes self_damage from divine super combat', () => {
    const effects = getPrepotEffects(getItemAction(23685).effects);

    expect(effects).toHaveLength(4);
    expect(effects.filter((effect) => effect.op === 'boost_formula')).toHaveLength(3);
    expect(effects.some((effect) => effect.op === 'divine_decay_lock')).toBe(true);
    expect(effects.some((effect) => effect.op === 'self_damage')).toBe(false);
  });

  it('keeps apply_timed_effect from extended stamina and removes restore_run', () => {
    const effects = getPrepotEffects(getItemAction(31638).effects);

    expect(effects).toHaveLength(1);
    expect(effects[0].op).toBe('apply_timed_effect');
    expect(effects.some((effect) => effect.op === 'restore_run')).toBe(false);
  });

  it('keeps forgotten brew magic boost but removes drain and restore effects', () => {
    const effects = getPrepotEffects(getItemAction(27629).effects);

    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ op: 'boost_formula', stat: 'magic' });
    expect(effects.some((effect) => effect.op === 'drain_formula')).toBe(false);
    expect(effects.some((effect) => effect.op === 'restore_prayer_formula')).toBe(false);
  });

  it('keeps cure_poison from sanfew serum, removes restore effects', () => {
    const effects = getPrepotEffects(getItemAction(10925).effects);

    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ op: 'cure_poison', immunitySteps: 20 });
  });

  it('keeps cure_poison from antidote++', () => {
    const effects = getPrepotEffects(getItemAction(5952).effects);

    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ op: 'cure_poison', immunitySteps: 40 });
  });

  it('returns an empty array for non-prepottable items', () => {
    const nonPrepottableIds = [13441, 29143, 3144, 22081, 229];

    for (const itemId of nonPrepottableIds) {
      expect(getPrepotEffects(getItemAction(itemId).effects)).toEqual([]);
    }
  });
});
