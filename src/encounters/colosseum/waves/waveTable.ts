/**
 * Fortis Colosseum waves 1-11 besides the Fremennik warband trio, which opens every wave.
 *
 * Wiki /w/Fortis_Colosseum/Strategies rev 15414089 "Wave breakdown". VERIFIED against the captures
 * (docs/encounters/fortis-colosseum-facts-spec.md): every captured wave 1-11 in A, B and C has these
 * starting species at T0 and these reinforcements at T0+66. Wave 1's jaguar is WIKI-ONLY: both
 * captured wave 1s ended before T0+66 (open question C1); policy reinforces a slow wave 1 too.
 */
export type ColosseumWaveSpecies =
  | 'serpentShaman'
  | 'javelinColossus'
  | 'manticore'
  | 'shockwaveColossus'
  | 'jaguarWarrior'
  | 'minotaur';

export interface ColosseumWaveComposition {
  /** Spawned at T0 on distinct spawn points, in this order (their processing order). */
  readonly initial: readonly ColosseumWaveSpecies[];
  /** Spawned at T0+66 at the gate nearer the player while the wave is still active. */
  readonly reinforcements: readonly ColosseumWaveSpecies[];
}

export const FIRST_COLOSSEUM_WAVE = 1;
export const LAST_COLOSSEUM_WAVE = 11;
/** Sol Heredit's wave. */
export const SOL_WAVE = 12;

const S = 'serpentShaman';
const JV = 'javelinColossus';
const M = 'manticore';
const SW = 'shockwaveColossus';
const JG = 'jaguarWarrior';
const MN = 'minotaur';

export const COLOSSEUM_WAVES: Readonly<Record<number, ColosseumWaveComposition>> = {
  1: { initial: [S], reinforcements: [JG] },
  2: { initial: [S, JV], reinforcements: [JG] },
  3: { initial: [S, JV, JV], reinforcements: [JG] },
  4: { initial: [S, M], reinforcements: [JG, S] },
  5: { initial: [S, JV, M], reinforcements: [JG, S] },
  6: { initial: [S, JV, JV, M], reinforcements: [JG, S] },
  7: { initial: [JV, M, SW], reinforcements: [MN] },
  8: { initial: [JV, JV, M, SW], reinforcements: [MN] },
  9: { initial: [JV, M, M], reinforcements: [MN] },
  10: { initial: [JV, JV, M, M], reinforcements: [MN, S] },
  11: { initial: [JV, M, M, SW], reinforcements: [MN, S] },
};

export function colosseumWave(wave: number): ColosseumWaveComposition {
  const composition = COLOSSEUM_WAVES[wave];
  if (!composition) throw new RangeError(`No Fortis Colosseum wave ${wave}`);
  return composition;
}

/** Ticks from T0 to the reinforcements: 38/38 adds in the 25 captured waves that reached it. */
export const COLOSSEUM_REINFORCEMENT_DELAY_TICKS = 66;
/** Tc to the intermission opening (Minimus' add): 27/27 completed waves. */
export const COLOSSEUM_OFFER_DELAY_TICKS = 3;
/** Accepted choice to T0: 30/30 confirmations, wave 12's included (A, B, C, K). */
export const COLOSSEUM_WAVE_START_DELAY_TICKS = 5;
/**
 * Game event on the tick Tk an intermission choice is accepted, `{ type, wave }` with the wave it
 * leads into; the game plays synth sound 8010 then (32/32 captured confirms), never for a rejected one.
 */
export const COLOSSEUM_MODIFIER_CONFIRMED_EVENT = 'colosseum_modifier_confirmed';

/** Wave 12 from its T0 (no `Wave: 12` message): A:4970-4976 and K:3992-3998. */
export const SOL_WAVE_SCHEDULE = {
  /** "Sol Heredit jumps down from his seat..." (A:4971, K:3993). */
  jumpMessage: 1,
  /** The player is moved to Sol's arena (A:4974, K:3996; the plane-0 placement follows at +5). */
  relocate: 4,
  /** Control C: Sol is added and the shield-warrior fence closes (A:4976, K:3998). */
  control: 6,
} as const;
