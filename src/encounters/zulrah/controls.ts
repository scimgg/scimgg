import type { EncounterControls } from '../../core/encounters/types';
import type { MechanicsConfig } from '../../types/simulation';
import type { ZulrahRotationNumber } from './rotation';

/** Mechanics key: Zulrah's attacks. Off leaves a punching bag that still rotates. */
export const ZULRAH_ATTACKS_KEY = 'zulrahAttacks';

/** Mechanics key: venom cloud barrages. Off, their turns pass with no clouds. */
export const ZULRAH_CLOUDS_KEY = 'zulrahClouds';

/** Mechanics key: snakeling orbs. Off, their turns pass with no snakelings. */
export const ZULRAH_SNAKELINGS_KEY = 'zulrahSnakelings';

/** Mechanics key: venom from Zulrah's and the snakelings' attacks. */
export const ZULRAH_VENOM_KEY = 'zulrahVenom';

/** Setup choice: `random`, or `1`-`4` to run only that rotation. */
export const ZULRAH_ROTATION_KEY = 'zulrahRotation';

/** The rotation pin; anything but 1-4 (including a stale stored value) is random. */
export function zulrahRotationPin(mechanics: Readonly<Partial<MechanicsConfig>>): ZulrahRotationNumber | null {
  const pin = mechanics[ZULRAH_ROTATION_KEY];
  return pin === '1' || pin === '2' || pin === '3' || pin === '4' ? (Number(pin) as ZulrahRotationNumber) : null;
}

export function buildZulrahControls(): EncounterControls {
  return {
    defaultMechanicsConfig: {
      infiniteHealth: false,
      [ZULRAH_ATTACKS_KEY]: true,
      [ZULRAH_CLOUDS_KEY]: true,
      [ZULRAH_SNAKELINGS_KEY]: true,
      [ZULRAH_VENOM_KEY]: true,
      [ZULRAH_ROTATION_KEY]: 'random',
    },
    mechanicsToggles: [
      { key: ZULRAH_ATTACKS_KEY, label: 'Zulrah Attacks' },
      { key: ZULRAH_CLOUDS_KEY, label: 'Venom Clouds' },
      { key: ZULRAH_SNAKELINGS_KEY, label: 'Snakelings' },
      { key: ZULRAH_VENOM_KEY, label: 'Venom' },
      {
        key: ZULRAH_ROTATION_KEY,
        label: 'Rotation',
        setup: true,
        info: 'Random picks a new rotation each time one ends. A number repeats that rotation.',
        choices: [
          { value: 'random', label: 'Random' },
          { value: '1', label: '1 (Crimson A)' },
          { value: '2', label: '2 (Crimson B)' },
          { value: '3', label: '3 (Serp)' },
          { value: '4', label: '4 (Tanz)' },
        ],
      },
    ],
    debugActions: [],
  };
}
