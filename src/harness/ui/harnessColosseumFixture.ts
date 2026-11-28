import { COLOSSEUM_START_WAVE_KEY } from '../../encounters/solHeredit/controls';
import { PERSISTED_SETTINGS_KEY } from '../../hooks/usePersistedSettings';
import { loadSetting, saveSetting } from '../../util/storage';
import type { HarnessOptions } from './harnessOptions';

/**
 * Saves `?colosseumStartWave=` as the Fortis Colosseum's Start wave before the app mounts, as the
 * setup control saves a player's choice, so the fight is entered on that wave like any saved start.
 * Call after the harness storage namespace is installed: it writes only harness storage, and the
 * value stays there for later harness runs until changed or reset, like any saved setting.
 */
export function seedHarnessColosseumStartWave(options: Pick<HarnessOptions, 'colosseumStartWave'>): void {
  if (options.colosseumStartWave === null) return;
  const stored = loadSetting<Record<string, unknown>>(PERSISTED_SETTINGS_KEY);
  const settings = stored !== null && typeof stored === 'object' ? stored : {};
  const rawPerEncounter = settings.mechanicsConfigPerEncounter;
  const perEncounter =
    rawPerEncounter !== null && typeof rawPerEncounter === 'object'
      ? (rawPerEncounter as Record<string, Record<string, unknown>>)
      : {};
  saveSetting(PERSISTED_SETTINGS_KEY, {
    ...settings,
    mechanicsConfigPerEncounter: {
      ...perEncounter,
      sol_heredit: { ...perEncounter.sol_heredit, [COLOSSEUM_START_WAVE_KEY]: String(options.colosseumStartWave) },
    },
  });
}
