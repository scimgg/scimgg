import type { EncounterControls } from '../../core/encounters/types';
import { WARDEN_MAX_HP } from '../../npcs/duke/duke';

export const DUKE_PRACTICE_KIND = 'duke_practice';
export const START_PHASE_KEY = 'dukePracticeStartPhase';
export const ALWAYS_BILE_KEY = 'dukePracticeAlwaysBile';

// Practice breakpoints from https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode
export const VENTS_HP = Math.floor(WARDEN_MAX_HP * 0.76);
export const BILE_HP = Math.floor(WARDEN_MAX_HP * 0.65);
// Practice estimate near one third HP. In 20261127-022231-Duke-Sucellus_7.jsonl,
// Duke drops from 581 to 547 at tick 252 and the first orb spawns at tick 255.
export const ORB_HP = Math.floor(WARDEN_MAX_HP * 0.33);
export const ENRAGE_HP = 440;

const PRACTICE_STARTS = [
  { value: 'opening', label: 'Opening', hp: WARDEN_MAX_HP },
  { value: 'vents', label: 'Vents', hp: VENTS_HP },
  { value: 'bile', label: 'Bile', hp: BILE_HP },
  { value: 'orbs', label: 'Orbs', hp: ORB_HP },
  { value: 'enrage', label: 'Enrage', hp: ENRAGE_HP },
];

export function practiceStartHp(value: unknown): number {
  return PRACTICE_STARTS.find((phase) => phase.value === value)?.hp ?? WARDEN_MAX_HP;
}

export const DUKE_PRACTICE_CONTROLS: EncounterControls = {
  defaultMechanicsConfig: { infiniteHealth: false, [START_PHASE_KEY]: 'opening', [ALWAYS_BILE_KEY]: false },
  mechanicsToggles: [
    {
      key: START_PHASE_KEY,
      label: 'Start at',
      setup: true,
      choices: PRACTICE_STARTS.map(({ value, label }) => ({ value, label })),
      info: 'Choose the phase and Hitpoints for the next attempt.',
      visibleInPractice: () => false,
    },
    {
      key: ALWAYS_BILE_KEY,
      label: 'Always Bile',
      group: 'aid',
      info: 'Force bile after every Gas Flare volley at any Hitpoints.',
    },
  ],
  debugActions: [],
  bossHpPresets: PRACTICE_STARTS.map(({ label, hp }) => ({ label, hp })),
};
