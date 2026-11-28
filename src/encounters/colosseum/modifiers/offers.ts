import {
  COLOSSEUM_MODIFIER_IDS,
  type ColosseumModifierId,
  colosseumModifierTierCount,
  SIMULATED_COLOSSEUM_MODIFIER_IDS,
} from './definitions';

/** One intermission choice: a modifier at the tier accepting it would give (owned tier + 1). */
export interface ColosseumModifierOffer {
  readonly id: ColosseumModifierId;
  readonly tier: number;
}

export interface ColosseumModifierOfferInput {
  /** The wave the accepted modifier first applies to, 1–12. */
  readonly nextWave: number;
  /** Owned tier per modifier; single-tier modifiers are owned at 1. */
  readonly owned: ReadonlyMap<ColosseumModifierId, number>;
  /** A stream reserved for offers, uniform in [0, 1). */
  readonly random: () => number;
  readonly supported: ReadonlySet<ColosseumModifierId>;
}

/** Modifiers whose effects the wave simulation implements; the gates below still apply per wave. */
export const SUPPORTED_WAVE_MODIFIERS: ReadonlySet<ColosseumModifierId> = new Set(SIMULATED_COLOSSEUM_MODIFIER_IDS);

/**
 * The offer before wave 1 with nothing owned, in the captured button order: B:1854 and C:1444 both
 * open `colosseum_intermission_2_init` with keys 4, 5, 12. Wiki /w/Fortis_Colosseum/Strategies
 * rev 15414089: "The first wave will always consist of a selection of Relentless, Blasphemy and
 * Frailty."
 */
export const COLOSSEUM_FIRST_OFFERS: readonly ColosseumModifierOffer[] = [
  { id: 'blasphemy', tier: 1 },
  { id: 'relentless', tier: 1 },
  { id: 'frailty', tier: 1 },
];

export const COLOSSEUM_OFFER_COUNT = 3;

/** Simulator policy, not a recovered server probability (the Wiki only says "a preference"). */
export const COLOSSEUM_UPGRADE_OFFER_WEIGHT = 2;
export const COLOSSEUM_NEW_OFFER_WEIGHT = 1;

/**
 * Wiki Strategies rev 15414089: "Red Flag and Dynamic Duo become available before wave 7 starts";
 * Wiki Modifiers rev 15163385: neither is "given as an option after wave 11". First seen going
 * into wave 7 (B:2925), never earlier in A/B/C.
 */
const LATE_WAVE_MODIFIERS: ReadonlySet<ColosseumModifierId> = new Set(['dynamicDuo', 'redFlag']);
/**
 * Mantimayhem: Wiki "Update:Varlamore Tweaks, GameJam V Commences & More!" (24 Apr 2024), "no longer
 * be offered as an option going into Wave 12". Reentry: Wiki Modifiers rev 15163385 only. Neither
 * appears in the two captured wave-12 offers (A:4871, C:3723).
 */
const NOT_BEFORE_SOL: ReadonlySet<ColosseumModifierId> = new Set(['mantimayhem', 'reentry']);
/**
 * Policy: Volatility III adds a molten-sand pool the simulation lacks, so it is withheld in waves
 * even though the game offers it (A:4184). Lift this when the pool is simulated.
 */
const UNSIMULATED_WAVE_TIERS: Readonly<Partial<Record<ColosseumModifierId, number>>> = { volatility: 3 };

export interface WeightedColosseumModifierOffer extends ColosseumModifierOffer {
  readonly weight: number;
}

/** The tier above the owned one, or null once maxed. Throws on an owned tier the modifier lacks. */
function nextTier(id: ColosseumModifierId, owned: ReadonlyMap<ColosseumModifierId, number>): number | null {
  const current = owned.get(id) ?? 0;
  const max = colosseumModifierTierCount(id);
  if (!Number.isInteger(current) || current < 0 || current > max) {
    throw new RangeError(`Owned ${id} tier ${current} is outside 0-${max}`);
  }
  return current < max ? current + 1 : null;
}

/**
 * Every modifier that may be taken going into `nextWave` (1-12), each at the tier above the owned
 * one, in cache key order: the one owner of the offer rules, which the draw's candidates and a
 * specific pick (the practice option of choosing off the offer, `ColosseumWaveRun.confirm`) both
 * read. Maxed tiers (including owned single-tier modifiers) are excluded, as the A/B/C captures never
 * re-offer either (30 intermissions); so are unsupported modifiers, the wave gates below and the
 * withheld tiers. Wave 1's fixed offer is a subset (`COLOSSEUM_FIRST_OFFERS`); the gates apply to it
 * as to any other wave, so a specific pick there may be any ungated modifier (policy).
 */
export function eligibleColosseumModifierPicks(
  input: Omit<ColosseumModifierOfferInput, 'random'>,
): readonly ColosseumModifierOffer[] {
  const { nextWave, owned, supported } = input;
  if (!Number.isInteger(nextWave) || nextWave < 1 || nextWave > 12) {
    throw new RangeError(`Modifiers precede waves 1-12, not ${nextWave}`);
  }
  return COLOSSEUM_MODIFIER_IDS.flatMap((id): ColosseumModifierOffer[] => {
    const tier = nextTier(id, owned);
    if (tier === null || !supported.has(id)) return [];
    if (LATE_WAVE_MODIFIERS.has(id) && (nextWave < 7 || nextWave > 11)) return [];
    if (NOT_BEFORE_SOL.has(id) && nextWave === 12) return [];
    if (UNSIMULATED_WAVE_TIERS[id] === tier) return [];
    return [{ id, tier }];
  });
}

/**
 * Every offer the draw could make going into waves 2-12: the eligible picks, owned modifiers
 * weighted as upgrades.
 */
export function colosseumModifierOfferCandidates(
  input: Omit<ColosseumModifierOfferInput, 'random'>,
): readonly WeightedColosseumModifierOffer[] {
  if (!Number.isInteger(input.nextWave) || input.nextWave < 2 || input.nextWave > 12) {
    throw new RangeError(`Drawn offers precede waves 2-12, not ${input.nextWave}`);
  }
  return eligibleColosseumModifierPicks(input).map((pick) => ({
    ...pick,
    weight: pick.tier > 1 ? COLOSSEUM_UPGRADE_OFFER_WEIGHT : COLOSSEUM_NEW_OFFER_WEIGHT,
  }));
}

/**
 * The intermission's choices going into `nextWave`. Wave 1: `COLOSSEUM_FIRST_OFFERS`, in that order
 * and without drawing, each at the tier above the owned one (policy, for a start with a configured
 * set) and left out once maxed. Otherwise three distinct candidates drawn by weight without
 * replacement, one `random()` per pick, returned in draw order (the game's buttons are unsorted too,
 * e.g. C:1482 keys 12, 0, 8). With fewer than three candidates every candidate is returned, so the
 * list can be shorter, or empty when nothing is left to offer; with the supported set and tier caps
 * that only happens after nearly every modifier is maxed.
 */
export function drawColosseumModifierOffers(input: ColosseumModifierOfferInput): readonly ColosseumModifierOffer[] {
  if (input.nextWave === 1) {
    const eligible = eligibleColosseumModifierPicks(input);
    return COLOSSEUM_FIRST_OFFERS.flatMap(({ id }) => eligible.filter((pick) => pick.id === id));
  }
  const pool = [...colosseumModifierOfferCandidates(input)];
  const offers: ColosseumModifierOffer[] = [];
  while (offers.length < COLOSSEUM_OFFER_COUNT && pool.length > 0) {
    const total = pool.reduce((sum, candidate) => sum + candidate.weight, 0);
    const roll = input.random() * total;
    // Defaults to the last candidate, so a stream returning 1 cannot pick past it.
    let index = pool.length - 1;
    let reached = 0;
    for (const [candidateIndex, candidate] of pool.entries()) {
      reached += candidate.weight;
      if (roll < reached) {
        index = candidateIndex;
        break;
      }
    }
    const [picked] = pool.splice(index, 1);
    offers.push({ id: picked!.id, tier: picked!.tier });
  }
  return offers;
}
