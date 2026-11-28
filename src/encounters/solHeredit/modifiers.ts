import type { EncounterModifierDefinition } from '../../core/encounters/encounterFactory';
import { type EncounterSetupNoteRule, loadoutHasItem } from '../../core/encounters/setupNotes';
import { COLOSSEUM_MODIFIERS, SIMULATED_COLOSSEUM_MODIFIER_IDS } from '../colosseum/modifiers/definitions';

/**
 * The modifiers a run's configured set may hold, for every start wave, in selector order: every
 * simulated modifier. Dynamic Duo and Red Flag only act in waves 1-11 (wave 12 has no shockwaves or
 * minotaurs). Shared behavior lives in colosseum/modifiers.
 */
export const SOL_HEREDIT_MODIFIERS: readonly EncounterModifierDefinition[] = SIMULATED_COLOSSEUM_MODIFIER_IDS.map(
  (id) => COLOSSEUM_MODIFIERS.find((definition) => definition.id === id)!,
);

// equipment.json also lists 33178, but that Barbarian Assault copy is not supported here.
const NOXIOUS_HALBERD_IDS: readonly number[] = [29796];

export const SOL_HEREDIT_SETUP_NOTES: readonly EncounterSetupNoteRule[] = [
  {
    id: 'halberd-without-myopia',
    // Myopia limits the halberd to range 1, still reaching diagonally adjacent tiles, so a halberd
    // run practiced without it is easier than the real wave 12; colosseum/modifiers/rules.ts.
    message: 'Noxious halberd in loadout, but Myopia is off.',
    applies: (ctx) => loadoutHasItem(ctx, NOXIOUS_HALBERD_IDS) && !ctx.modifiers.myopia,
  },
];
