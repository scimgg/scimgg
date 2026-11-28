// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { setStorageNamespace } from '../../../util/storage';
import { seedHarnessColosseumStartWave } from '../harnessColosseumFixture';
import { HARNESS_STORAGE_NAMESPACE } from '../harnessEnvironment';
import { parseHarnessOptions } from '../harnessOptions';

const KEY = `${HARNESS_STORAGE_NAMESPACE}osrs-yama-settings`;

describe('?colosseumStartWave=', () => {
  afterEach(() => {
    localStorage.removeItem(KEY);
    setStorageNamespace('');
  });

  it('reads a whole wave 1-12, only for sol_heredit', () => {
    expect(parseHarnessOptions('?encounter=sol_heredit&colosseumStartWave=4').colosseumStartWave).toBe(4);
    expect(parseHarnessOptions('?encounter=sol_heredit&colosseumStartWave=13').colosseumStartWave).toBeNull();
    expect(parseHarnessOptions('?encounter=sol_heredit&colosseumStartWave=2.5').colosseumStartWave).toBeNull();
    expect(parseHarnessOptions('?encounter=inferno&colosseumStartWave=4').colosseumStartWave).toBeNull();
    expect(parseHarnessOptions('?encounter=sol_heredit').colosseumStartWave).toBeNull();
  });

  it('saves it in harness storage beside the saved settings, as the Start wave control does', () => {
    setStorageNamespace(HARNESS_STORAGE_NAMESPACE);
    localStorage.setItem(
      KEY,
      JSON.stringify({ logLevel: 'none', mechanicsConfigPerEncounter: { sol_heredit: { infiniteHealth: true } } }),
    );
    seedHarnessColosseumStartWave({ colosseumStartWave: 4 });
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')).toEqual({
      logLevel: 'none',
      mechanicsConfigPerEncounter: { sol_heredit: { infiniteHealth: true, colosseumStartWave: '4' } },
    });
    // Nothing to seed leaves storage alone.
    seedHarnessColosseumStartWave({ colosseumStartWave: null });
    expect(
      JSON.parse(localStorage.getItem(KEY) ?? '{}').mechanicsConfigPerEncounter.sol_heredit.colosseumStartWave,
    ).toBe('4');
  });
});
