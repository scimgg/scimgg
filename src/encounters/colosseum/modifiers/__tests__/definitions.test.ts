import { expect, it } from 'vitest';
import { SOL_HEREDIT_MODIFIERS } from '../../../solHeredit/modifiers';
import {
  COLOSSEUM_MODIFIER_CACHE_KEYS,
  COLOSSEUM_MODIFIER_IDS,
  COLOSSEUM_MODIFIERS,
  colosseumModifierTierCount,
} from '../definitions';
import { SUPPORTED_WAVE_MODIFIERS } from '../offers';

it('catalogs all fourteen in-game modifiers in cache key order with their tier counts', () => {
  expect(COLOSSEUM_MODIFIER_IDS.map((id) => COLOSSEUM_MODIFIER_CACHE_KEYS[id])).toEqual([...Array(14).keys()]);
  expect(new Set(COLOSSEUM_MODIFIERS.map(({ id }) => id))).toEqual(new Set(COLOSSEUM_MODIFIER_IDS));
  expect(COLOSSEUM_MODIFIERS).toHaveLength(14);
  // Cache enum 5312 struct param 1901: Quartet, Totemic, Dynamic Duo and Red Flag are single-tier.
  const single = COLOSSEUM_MODIFIER_IDS.filter((id) => colosseumModifierTierCount(id) === 1);
  expect(single).toEqual(['quartet', 'totemic', 'dynamicDuo', 'redFlag']);
});

it('offers the run setup its twelve simulated modifiers, without Mantimayhem or Reentry', () => {
  expect(SOL_HEREDIT_MODIFIERS.map(({ id }) => id)).toEqual([
    'bees',
    'blasphemy',
    'doom',
    'dynamicDuo',
    'frailty',
    'myopia',
    'quartet',
    'redFlag',
    'relentless',
    'solarflare',
    'totemic',
    'volatility',
  ]);
  // One list: the waves offer exactly what the setup may configure.
  expect([...SUPPORTED_WAVE_MODIFIERS]).toEqual(SOL_HEREDIT_MODIFIERS.map(({ id }) => id));
});
