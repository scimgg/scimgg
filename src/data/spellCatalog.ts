import { z } from 'zod';
import type { SpellbookType } from '../types/spellbook';
import generatedSpells from './osrs/spells.json';

/**
 * The non-damage half of a combat spell, as the OSRS Wiki states it per family. Only the
 * Ancient Magicks carry one today; the field is absent for every other spell rather than
 * nullable, so a book that never had a secondary effect reads the same as one not yet modeled.
 *
 * Chance to apply is NOT here: Smoke is the only family that rolls for its effect and the same
 * 1/8 covers all four of its spells, so it lives beside the roll in `spellHitEffects.ts`.
 */
export type SpellSecondaryEffect =
  | {
      /** /w/Smoke_spells: severity 10 for Rush/Burst, 20 for Blitz/Barrage. */
      readonly kind: 'poison';
      readonly severity: number;
    }
  | {
      /** /w/Shadow_spells: 10% of the target's ATTACK for Rush/Burst, 15% for Blitz/Barrage. */
      readonly kind: 'drain_attack';
      readonly percent: number;
    }
  | {
      /** /w/Blood_spells: 25% for all four, before Bloodbark/sceptre modifiers. */
      readonly kind: 'leech_hp';
      readonly percentOfDamage: number;
    }
  | {
      /** /w/Ice_spells: 8/16/24/32 ticks for Rush/Burst/Blitz/Barrage. */
      readonly kind: 'freeze';
      readonly durationTicks: number;
    };

const SPELL_ELEMENTS = ['air', 'water', 'earth', 'fire'] as const;

/** The four elements of the standard spellbook's elemental spells, and of a monster's elemental weakness. */
export type SpellElement = (typeof SPELL_ELEMENTS)[number];

export interface OsrsSpell {
  readonly name: string;
  readonly spellbook: SpellbookType;
  readonly element: SpellElement | null;
  readonly maxHit: number;
  readonly scalesWithMagic?: 'magic_dart';
  readonly secondaryEffect?: SpellSecondaryEffect;
}

const secondaryEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('poison'), severity: z.number() }),
  z.object({ kind: z.literal('drain_attack'), percent: z.number() }),
  z.object({ kind: z.literal('leech_hp'), percentOfDamage: z.number() }),
  z.object({ kind: z.literal('freeze'), durationTicks: z.number() }),
]);

const spells: readonly OsrsSpell[] = z
  .array(
    z.object({
      name: z.string(),
      spellbook: z.enum(['standard', 'ancient', 'lunar', 'arceuus']),
      element: z.enum(SPELL_ELEMENTS).nullable(),
      maxHit: z.number(),
      scalesWithMagic: z.literal('magic_dart').optional(),
      secondaryEffect: secondaryEffectSchema.optional(),
    }),
  )
  .parse(generatedSpells);

/** Every combat spell reaches 10 tiles; only powered staves deviate, and those are not spells. */
export const DEFAULT_SPELL_ATTACK_RANGE = 10;

/**
 * Attack speed of a spell cast, in ticks. Matches the casting stances handled by
 * `getEffectiveCombatParams`, and applies to a manual cast from any weapon.
 */
export const SPELL_CAST_SPEED = 5;

/**
 * Spells present in the damage catalog that cannot be set as an autocast in OSRS.
 * These are manual single-target casts whose effect is not raw damage, so offering
 * them in the autocast picker would let the player pick a spell the game never casts
 * on its own.
 */
const NON_AUTOCAST_SPELLS: ReadonlySet<string> = new Set([
  'Dark Lure',
  'Lesser Corruption',
  'Greater Corruption',
  'Bind',
  'Snare',
  'Entangle',
  'Confuse',
  'Weaken',
  'Curse',
  'Vulnerability',
  'Enfeeble',
  'Stun',
  'Tele Block',
]);

/**
 * Spells that land on a fixed tick delay regardless of distance, overriding the
 * standard magic hit-delay formula.
 */
const FIXED_HIT_DELAY_SPELLS: Readonly<Record<string, number>> = {
  'Inferior Demonbane': 2,
  'Superior Demonbane': 2,
  'Dark Demonbane': 2,
};

const MULTI_TARGET_ANCIENT_SPELLS: ReadonlySet<string> = new Set([
  'Smoke Burst',
  'Shadow Burst',
  'Blood Burst',
  'Ice Burst',
  'Smoke Barrage',
  'Shadow Barrage',
  'Blood Barrage',
  'Ice Barrage',
]);

export interface SpellMultiTargetInfo {
  readonly radius: 1;
  /** Includes the selected primary target. */
  readonly maxTargets: 9;
}

/**
 * Interface sprite base name for a spell. The sprites store spells as
 * lowercase snake_case of the display name, which round-trips every spell in the
 * catalog (`Ice Barrage` -> `ice_barrage`, `Dark Demonbane` -> `dark_demonbane`).
 */
export function spellIconName(spellName: string): string {
  return spellName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Combat spells of a book that the player may set as an autocast, in catalog order. */
export function getAutocastableSpells(spellbook: SpellbookType): readonly OsrsSpell[] {
  return spells.filter((spell) => spell.spellbook === spellbook && !NON_AUTOCAST_SPELLS.has(spell.name));
}

/** True when `spellName` is a combat spell the simulation can resolve damage for. */
export function isCastableSpell(spellName: string): boolean {
  return spells.some((spell) => spell.name === spellName);
}

export function isAutocastableSpell(spellName: string): boolean {
  return !NON_AUTOCAST_SPELLS.has(spellName) && isCastableSpell(spellName);
}

export interface SpellCastInfo {
  readonly name: string;
  readonly spellbook: SpellbookType;
  /** Interface sprite base name (no extension, no size suffix). */
  readonly icon: string;
  readonly attackRange: number;
  /** Fixed hit delay in game ticks. Undefined = standard magic distance formula. */
  readonly fixedHitDelay?: number;
  readonly multiTarget?: SpellMultiTargetInfo;
  readonly secondaryEffect?: SpellSecondaryEffect;
}

/** Cast parameters for a spell name, or null when the name is not a known combat spell. */
export function getSpellCastInfo(spellName: string): SpellCastInfo | null {
  const spell = spells.find((candidate) => candidate.name === spellName);
  if (!spell) return null;
  const fixedHitDelay = FIXED_HIT_DELAY_SPELLS[spell.name];
  const multiTarget = MULTI_TARGET_ANCIENT_SPELLS.has(spell.name) ? ({ radius: 1, maxTargets: 9 } as const) : undefined;
  return {
    name: spell.name,
    spellbook: spell.spellbook,
    icon: spellIconName(spell.name),
    attackRange: DEFAULT_SPELL_ATTACK_RANGE,
    ...(fixedHitDelay === undefined ? {} : { fixedHitDelay }),
    ...(multiTarget === undefined ? {} : { multiTarget }),
    ...(spell.secondaryEffect === undefined ? {} : { secondaryEffect: spell.secondaryEffect }),
  };
}
