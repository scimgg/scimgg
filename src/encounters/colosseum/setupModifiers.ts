/**
 * How the configurer names a Fortis Colosseum run's modifier set. Its default is the start wave's
 * suggestion (the descriptor's `defaultModifiers`); whether the player has saved a set of their own
 * is the saved setup's (`useEncounterManager`), so only the labels live here.
 */
import type { MechanicsConfig } from '../../types/simulation';
import { resolveColosseumStartWave } from '../solHeredit/controls';

/** The set's heading in the configurer: what it is, the modifiers owned going into the start wave. */
export function colosseumModifierHeading(config: Readonly<Partial<MechanicsConfig>>): string {
  return `Modifiers going into wave ${resolveColosseumStartWave(config)}`;
}

export function colosseumModifierResetLabel(config: Readonly<Partial<MechanicsConfig>>): string {
  return `Reset to wave ${resolveColosseumStartWave(config)} default`;
}
