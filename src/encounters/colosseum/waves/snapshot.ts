import type { ColosseumModifierId } from '../modifiers/definitions';

export type ColosseumStage = 'intermission' | 'wave' | 'sol';

export interface ColosseumModifierChoice {
  readonly id: ColosseumModifierId;
  /** The tier accepting it gives: the owned tier + 1. */
  readonly tier: number;
}

/**
 * One owned modifier tier source: `set`, the run's configured set (one entry per modifier at its set
 * tier, owned going into the start wave and in force from its T0); or `live`, an intermission choice.
 */
export type ColosseumPick = ColosseumModifierChoice &
  (
    | { readonly origin: 'set'; readonly wave: null; readonly tick: null }
    | {
        readonly origin: 'live';
        /** The wave the choice was made going into. */
        readonly wave: number;
        /** The tick it was accepted on. */
        readonly tick: number;
      }
  );

/** An open intermission choice going into `wave`. */
export interface ColosseumModifierOfferState {
  readonly wave: number;
  /** The game's offer: the three drawn (wave 1's fixed list), in button order. */
  readonly options: readonly ColosseumModifierChoice[];
  /**
   * Every choice `confirm-modifier` accepts for this wave, in cache key order: the options and any
   * other modifier the rules allow here (`eligibleColosseumModifierPicks`), a practice option.
   */
  readonly eligible: readonly ColosseumModifierChoice[];
}

/**
 * The run's wave state, plain and `structuredClone`-safe. Absent from recordings made before the
 * waves existed, which are direct Sol starts: read it through {@link colosseumRunState}.
 */
export interface ColosseumRunPublicState {
  /** 1-12; 12 is a direct Sol Heredit start. */
  readonly startWave: number;
  /** The wave being fought, or the one the current intermission leads into. */
  readonly wave: number;
  /** `sol` from wave 12's start (the jump to the arena) onward, and for a direct start. */
  readonly stage: ColosseumStage;
  /** T0 of `wave` once scheduled (an accepted choice + 5), else null. */
  readonly waveStartTick: number | null;
  /** Tc of the wave before `wave`, during the intermission that follows it; else null. */
  readonly waveCompletedTick: number | null;
  /** T0 + 66 while the active wave's reinforcements are still to come; else null. */
  readonly reinforcementTick: number | null;
  /** C, the tick Sol is added: 0 for a direct start, known from wave 12's start. */
  readonly solControlTick: number | null;
  /** The open choice, from the completion + 3 (tick 0 for a start) until one is accepted. */
  readonly offer: ColosseumModifierOfferState | null;
  /** The configured set's entries (catalog order), then every live pick, oldest first. */
  readonly picks: readonly ColosseumPick[];
}

/**
 * A wave run's practice setup, as the Inferno publishes its own (`InfernoPublicState`): what the run
 * was STARTED with, which the setup control compares the saved setup against, and what the wave being
 * fought actually spawned, which the layout tool copies so a random spawn can be repeated. Plain and
 * `structuredClone`-safe. Absent for a direct Sol start, which has no wave layout.
 */
export interface ColosseumRunSetupState {
  /** The start wave's layout this run was started with (`serializeColosseumSpawnLayout`), '' for random. */
  readonly startSpawnLayout: string;
  /** The tile this run opened on (`serializeColosseumStartTile`, the setup's resolved tile). */
  readonly startPlayerTile: string;
  /**
   * The spawn points the wave being fought placed its initial NPCs on (`serializeColosseumSpawnLayout`),
   * random or chosen; '' through an intermission, before the wave spawns, and from wave 12 on.
   * Dynamic Duo's partners stand off the points, so they are not part of it.
   */
  readonly waveSpawnLayout: string;
  /**
   * The player's tile at the start of that wave's T0, the one its points were drawn clear of
   * (`planColosseumWave`); null whenever {@link waveSpawnLayout} is ''.
   */
  readonly waveStartPlayerTile: readonly [number, number] | null;
}

export const DIRECT_SOL_RUN_STATE: ColosseumRunPublicState = Object.freeze({
  startWave: 12,
  wave: 12,
  stage: 'sol',
  waveStartTick: null,
  waveCompletedTick: null,
  reinforcementTick: null,
  solControlTick: 0,
  offer: null,
  picks: [],
});

/** The run state of a Sol Heredit snapshot; a recording without one is a direct Sol start. */
export function colosseumRunState(state: { readonly run?: ColosseumRunPublicState }): ColosseumRunPublicState {
  return state.run ?? DIRECT_SOL_RUN_STATE;
}
