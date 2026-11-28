import type { ColosseumModifierId } from '../colosseum/modifiers/definitions';

/**
 * `confirm-modifier` is the intermission's Continue: a recorded gameplay input, not a practice aid.
 * `wave` is the wave the open choice leads into (`ColosseumRunPublicState.offer.wave`); the run
 * rejects a stale, duplicate, wrong-stage or off-list choice when it executes.
 */
export type SolHereditEncounterCommand =
  | {
      readonly encounter: 'sol_heredit';
      readonly type: 'confirm-modifier';
      readonly wave: number;
      readonly modifierId: ColosseumModifierId;
    }
  /**
   * A practice restart, answered by `SolHereditEncounter.planPracticeRestart` rather than run in-fight:
   * a fresh run of the saved setup from `wave`, as the layout tool's Start sends it. The wave travels
   * with the command, as the Inferno's `go-to-wave` does: the press that sends it also saves it, and
   * the save has not reached the engine by the time the restart is planned.
   */
  | { readonly encounter: 'sol_heredit'; readonly type: 'go-to-wave'; readonly wave: number }
  | { readonly encounter: 'sol_heredit'; readonly type: 'spawn-crystal' }
  | { readonly encounter: 'sol_heredit'; readonly type: 'trigger-grapple' }
  | { readonly encounter: 'sol_heredit'; readonly type: 'trigger-triple' }
  | { readonly encounter: 'sol_heredit'; readonly type: 'strike-sand' }
  | { readonly encounter: 'sol_heredit'; readonly type: 'clear-sand' };

export const SOL_HEREDIT_DEBUG_ACTIONS = [
  { command: { encounter: 'sol_heredit', type: 'trigger-grapple' }, label: 'Trigger grapple' },
  { command: { encounter: 'sol_heredit', type: 'trigger-triple' }, label: 'Trigger triple attack' },
  { command: { encounter: 'sol_heredit', type: 'spawn-crystal' }, label: 'Add beam crystal' },
  { command: { encounter: 'sol_heredit', type: 'strike-sand' }, label: 'Strike molten sand' },
  { command: { encounter: 'sol_heredit', type: 'clear-sand' }, label: 'Clear molten sand' },
] as const satisfies readonly { readonly command: SolHereditEncounterCommand; readonly label: string }[];
