import { expect, it } from 'vitest';
import { filterModifierSelection } from '../../../../core/encounters/encounterFactory';
import { SOL_HEREDIT_MODIFIERS } from '../../../solHeredit/modifiers';
import { colosseumDefaultModifiers } from '../defaults';

it('suggests no modifiers on wave 1, then Blasphemy I, II from wave 3 and III from wave 6', () => {
  const byWave = Array.from({ length: 12 }, (_, index) => colosseumDefaultModifiers(index + 1));
  expect(byWave).toEqual([
    {},
    { blasphemy: 1 },
    { blasphemy: 2 },
    { blasphemy: 2 },
    { blasphemy: 2 },
    ...Array.from({ length: 7 }, () => ({ blasphemy: 3 })),
  ]);
  // Every suggestion is a set the run setup can hold.
  for (const set of byWave) expect(filterModifierSelection(SOL_HEREDIT_MODIFIERS, set)).toEqual(set);
});

it('keeps the direct Sol default, Blasphemy III, on wave 12', () => {
  expect(colosseumDefaultModifiers(12)).toEqual({ blasphemy: 3 });
});

it('rejects a start wave outside 1-12', () => {
  for (const wave of [0, 13, 2.5, Number.NaN]) expect(() => colosseumDefaultModifiers(wave)).toThrow(RangeError);
});
