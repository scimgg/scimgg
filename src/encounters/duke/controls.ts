import type { EncounterControls } from '../../core/encounters/types';
import { WARDEN_MAX_HP } from '../../npcs/duke/duke';
import { DUKE_ALWAYS_BILE_KEY, DUKE_START_PHASE_KEY } from '../../types/duke';

// Practice breakpoints from https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode
export const VENTS_HP = Math.floor(WARDEN_MAX_HP * 0.76);
export const BILE_HP = Math.floor(WARDEN_MAX_HP * 0.65);
// Practice estimate near one third HP. In 20261127-022231-Duke-Sucellus_7.jsonl,
// Duke drops from 581 to 547 at tick 252 and the first orb spawns at tick 255.
export const ORB_HP = Math.floor(WARDEN_MAX_HP * 0.33);
export const ENRAGE_HP = 440;

const START_PHASES = [
  { value: 'opening', label: 'Opening', hp: WARDEN_MAX_HP },
  { value: 'vents', label: 'Vents', hp: VENTS_HP },
  { value: 'bile', label: 'Bile', hp: BILE_HP },
  { value: 'orbs', label: 'Orbs', hp: ORB_HP },
  { value: 'enrage', label: 'Enrage', hp: ENRAGE_HP },
];

export function dukeStartHp(value: unknown): number {
  return START_PHASES.find((phase) => phase.value === value)?.hp ?? WARDEN_MAX_HP;
}

export const DUKE_CONTROLS: EncounterControls = {
  defaultMechanicsConfig: { infiniteHealth: false, [DUKE_START_PHASE_KEY]: 'opening', [DUKE_ALWAYS_BILE_KEY]: false },
  mechanicsToggles: [
    {
      key: DUKE_START_PHASE_KEY,
      label: 'Start at',
      setup: true,
      choices: START_PHASES.map(({ value, label }) => ({ value, label })),
      info: 'Choose the phase and Hitpoints for the next attempt.',
      visibleInPractice: () => false,
    },
    {
      key: DUKE_ALWAYS_BILE_KEY,
      label: 'Always Bile',
      group: 'aid',
      info: 'Force bile after every Gas Flare volley at any Hitpoints.',
    },
  ],
  debugActions: [],
  bossHpPresets: START_PHASES.map(({ label, hp }) => ({ label, hp })),
};
