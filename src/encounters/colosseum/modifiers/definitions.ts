import type { EncounterModifierDefinition } from '../../../core/encounters/encounterFactory';

export type ColosseumModifierId =
  | 'solarflare'
  | 'volatility'
  | 'doom'
  | 'frailty'
  | 'blasphemy'
  | 'myopia'
  | 'bees'
  | 'quartet'
  | 'totemic'
  | 'relentless'
  | 'mantimayhem'
  | 'reentry'
  | 'dynamicDuo'
  | 'redFlag';

/**
 * Cache enum 5312 key of each modifier, which is also its bit in the intermission's owned-modifier
 * mask (struct param 1895). These are the ids `colosseum_intermission_2_init` (clientscript 4931)
 * receives as offers. VERIFIED against every offer and stack-varbit change in the wave captures
 * A/B/C (e.g. C:1482 mask 16 = Blasphemy; A:1107 mask 144 = Blasphemy + Totemic).
 *
 * The key order is also the stable order offers are drawn in (offers.ts).
 */
export const COLOSSEUM_MODIFIER_CACHE_KEYS: Readonly<Record<ColosseumModifierId, number>> = {
  mantimayhem: 0,
  reentry: 1,
  bees: 2,
  volatility: 3,
  blasphemy: 4,
  relentless: 5,
  quartet: 6,
  totemic: 7,
  doom: 8,
  dynamicDuo: 9,
  solarflare: 10,
  myopia: 11,
  frailty: 12,
  redFlag: 13,
};

/** All fourteen in-game modifiers in cache key order. */
export const COLOSSEUM_MODIFIER_IDS: readonly ColosseumModifierId[] = (
  Object.keys(COLOSSEUM_MODIFIER_CACHE_KEYS) as ColosseumModifierId[]
).sort((left, right) => COLOSSEUM_MODIFIER_CACHE_KEYS[left] - COLOSSEUM_MODIFIER_CACHE_KEYS[right]);

/**
 * The modifiers the simulation implements, in the run setup's alphabetical selector order (the
 * wiki's modifier table's; the game offers random picks and has no fixed order). Mantimayhem and
 * Reentry are deferred. Both the setup's choices (solHeredit/modifiers.ts) and the waves' offers
 * (`SUPPORTED_WAVE_MODIFIERS`, offers.ts, which keeps its own wave gates) come from this list.
 */
export const SIMULATED_COLOSSEUM_MODIFIER_IDS: readonly ColosseumModifierId[] = [
  'bees',
  'blasphemy',
  'doom',
  'dynamicDuo',
  'frailty',
  'myopia',
  'quartet',
  'redFlag',
  'relentless',
  'solarflare',
  'totemic',
  'volatility',
];

export type ColosseumModifierDefinition = EncounterModifierDefinition & { readonly id: ColosseumModifierId };

/**
 * Shared Fortis Colosseum modifier definitions, one per in-game modifier. Only
 * `SIMULATED_COLOSSEUM_MODIFIER_IDS` are offered, so a catalog entry is not a claim that it is
 * simulated.
 * rules.ts owns Doom, Blasphemy, Frailty and Myopia; Relentless lives with the NPC attacks it changes
 * (src/npcs/colosseum). Solarflare/Volatility helpers own their hits;
 * Run A verifies timing/exclusions, while their uniform damage ranges remain models.
 *
 * Effect text follows the OSRS Wiki's modifier table (/w/Fortis_Colosseum/Modifiers, rev 15163385).
 * Tier counts match cache struct param 1901 (tiered flag) for enum 5312.
 */
export const COLOSSEUM_MODIFIERS: readonly ColosseumModifierDefinition[] = [
  {
    id: 'solarflare',
    name: 'Solarflare',
    icon: '/assets/encounters/modifier-solarflare.png',
    summary: 'An orb circles the pillars, dealing 10–20 damage.',
    tiers: [
      'The orb moves every 2 ticks, with 7-tick corner gaps. Departure hits land one tick later.',
      'The orb moves every 2 ticks without stopping. Departure hits land one tick later.',
      'The orb moves every tick, with 2-tick corner gaps, and disables protection prayers on departure. Hits land one tick later.',
    ],
  },
  {
    id: 'volatility',
    name: 'Volatility',
    icon: '/assets/encounters/modifier-volatility.png',
    summary: 'Enemies explode when they die, dealing 16–24 damage.',
    tiers: [
      'The explosion reaches one tile beyond the enemy footprint.',
      'The explosion reaches two tiles beyond the enemy footprint.',
      "The explosion reaches two tiles beyond the enemy footprint. The center sand pool isn't simulated yet.",
    ],
  },
  {
    id: 'doom',
    name: 'Doom',
    icon: '/assets/encounters/modifier-doom.png',
    summary: 'Every damaging enemy hit adds a Doom stack; enough stacks kill you.',
    tiers: [
      'Every damaging enemy hit adds a stack of Doom; 15 stacks kill you.',
      'Doom kills at 10 stacks.',
      'Doom kills at 5 stacks.',
    ],
  },
  {
    id: 'frailty',
    name: 'Frailty',
    icon: '/assets/encounters/modifier-frailty.png',
    summary: 'Base Hitpoints are reduced and overhealing is disabled.',
    tiers: [
      'Base Hitpoints are reduced by 10%; overhealing is disabled.',
      'Base Hitpoints are reduced by 20%.',
      'Base Hitpoints are reduced by 40%.',
    ],
  },
  {
    id: 'blasphemy',
    name: 'Blasphemy',
    icon: '/assets/encounters/modifier-blasphemy.png',
    summary: 'Each full 5 damage taken drains prayer points, except Solarflare, Volatility and Bees! hits.',
    tiers: [
      'Drain 1 prayer point per full 5 damage taken, excluding Solarflare, Volatility and Bees!.',
      'Drain 2 prayer points per full 5 damage taken, excluding Solarflare, Volatility and Bees!.',
      'Drain 3 prayer points per full 5 damage taken, excluding Solarflare, Volatility and Bees!.',
    ],
  },
  {
    id: 'myopia',
    name: 'Myopia',
    icon: '/assets/encounters/modifier-myopia.png',
    summary: 'Attack range is reduced; manually cast spells are unaffected.',
    tiers: [
      'Attack range is reduced by 2 tiles; manually cast spells are unaffected.',
      'Attack range is reduced by 4 tiles; manually cast spells are unaffected.',
      'Attack range is reduced by 6 tiles; manually cast spells are unaffected.',
    ],
  },
  {
    id: 'bees',
    name: 'Bees!',
    icon: '/assets/encounters/modifier-bees.png',
    // Wiki Modifiers oldid=15163385: swarms pursue and sting; higher tiers add swarms.
    summary: 'Bee swarms pursue you and sting when they catch you. Defeated swarms return after a delay.',
    tiers: ['1 bee swarm', '2 bee swarms', '3 bee swarms'],
  },
  {
    id: 'quartet',
    name: 'Quartet',
    icon: '/assets/encounters/modifier-quartet.png',
    // Wiki /w/Fortis_Colosseum/Modifiers (revision not pinned): "An extra random Fremennik Warbander
    // spawns every wave"; a single tier.
    summary: 'A random Fremennik warbander joins the fight.',
    tiers: ['One berserker, archer or seer, chosen at random, sticks beside you and attacks every 6 ticks.'],
  },
  {
    id: 'totemic',
    name: 'Totemic',
    icon: '/assets/encounters/modifier-totemic.png',
    // Wiki /w/Fortis_Colosseum/Modifiers rev 15163385: a single tier. Heal amounts are per encounter.
    summary: 'A 1 HP healing totem appears beside a wounded enemy and heals it.',
    tiers: [
      'At half HP a totem appears beside the enemy and heals it every 6 ticks while it is hurt. A destroyed totem returns 2 minutes later.',
    ],
  },
  {
    id: 'relentless',
    name: 'Relentless',
    icon: '/assets/encounters/modifier-relentless.png',
    // Wiki /w/Fortis_Colosseum/Modifiers (revision not pinned). Applied to enemies' own attacks, not
    // to modifier or arena hazards; Sol's triple gets the max-hit bonus, his regular AoE does not
    // (npcs/colosseum/constants.ts).
    summary: 'Enemies bypass part of your Defence level and hit harder.',
    tiers: [
      'Enemies bypass 33% of your Defence level, and their max hit is increased by 1.',
      'Enemies bypass 66% of your Defence level, and their max hit is increased by 3.',
      'Enemies ignore accuracy checks entirely, and their max hit is increased by 6.',
    ],
  },
  // Not simulated; no icon asset yet. Wiki Modifiers rev 15163385.
  {
    id: 'mantimayhem',
    name: 'Mantimayhem',
    icon: '/assets/encounters/modifier-mantimayhem.png',
    summary: 'Manticores fire more projectiles, and higher tiers add venom and shuffle the melee orb.',
    tiers: [
      'Manticores fire an additional projectile per orb.',
      'Manticores fire an additional projectile per orb, and unprotected hits apply venom.',
      'As tier II, and the melee orb can come anywhere in the sequence.',
    ],
  },
  {
    id: 'reentry',
    name: 'Reentry',
    icon: '/assets/encounters/modifier-reentry.png',
    summary: 'Javelins leave molten sand where they land.',
    tiers: [
      'Javelins leave a pool of molten sand until the wave ends.',
      'Javelins leave a bigger, permanent pool of molten sand.',
      'Javelins leave a very big, permanent pool of molten sand.',
    ],
  },
  {
    id: 'dynamicDuo',
    name: 'Dynamic Duo',
    icon: '/assets/encounters/modifier-dynamic-duo.png',
    summary: 'Shockwave Colossi always spawn in pairs.',
    tiers: ['Every Shockwave Colossus is joined by a second one spawned nearby.'],
  },
  {
    id: 'redFlag',
    name: 'Red Flag',
    icon: '/assets/encounters/modifier-red-flag.png',
    summary: 'Minotaurs can no longer be safespotted.',
    tiers: ['Minotaurs path around obstacles to reach you.'],
  },
];

/** 3 for tiered modifiers, 1 for single-tier ones (cache struct param 1901). */
export function colosseumModifierTierCount(id: ColosseumModifierId): number {
  const definition = COLOSSEUM_MODIFIERS.find((candidate) => candidate.id === id);
  if (!definition) throw new RangeError(`Unknown Colosseum modifier ${id}`);
  return definition.tiers.length;
}
