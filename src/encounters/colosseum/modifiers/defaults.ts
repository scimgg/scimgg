import type { EncounterModifierSelection } from '../../../core/encounters/encounterFactory';

/** A Fortis Colosseum run's configured modifier set: tier per modifier id, an absent id off. */
export type ColosseumModifierSelection = EncounterModifierSelection;

/**
 * The modifier set a run starting on `startWave` (1-12) suggests before the player edits it:
 * Blasphemy at the tier a run would usually hold by then. Wave 1 starts with none, wave 2 with
 * Blasphemy I, waves 3-5 with II and waves 6-12 with III; wave 12's III is the direct Sol default.
 * Suggestion policy only (the user's choice), not a recovered game rule. The run itself plays the
 * saved set as given, whatever its start wave.
 */
export function colosseumDefaultModifiers(startWave: number): ColosseumModifierSelection {
  if (!Number.isInteger(startWave) || startWave < 1 || startWave > 12) {
    throw new RangeError(`Fortis Colosseum start waves are 1-12, not ${startWave}`);
  }
  if (startWave === 1) return {};
  if (startWave === 2) return { blasphemy: 1 };
  if (startWave <= 5) return { blasphemy: 2 };
  return { blasphemy: 3 };
}
