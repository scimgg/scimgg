import { getCanonicalEquipmentItemId } from '../../../data/equipmentCatalog';
import { getEquipmentCombatBaseId } from '../../../data/equipmentCombatFamilies';
import type { CombatStyle } from '../../../types/attackStyles';
import type { ResolvedAttackResources } from '../attackResources';
import { CALC_GAPS } from '../combatGaps';
import type { CombatFormulaStyle } from '../formulas';
import type {
  AccuracyBranchProfile,
  AllMissOutcomeProfile,
  FormulaAccuracyProfile,
  FormulaRatio,
  FractionBound,
  HitRollProfile,
  MaxHitProfile,
  PlayerAttackProfile,
} from '../playerAttackProfiles';
import type { NonEmptyReadonlyArray } from '../playerAttackTypes';
import { chinchompaFuseAccuracy } from './chinchompa';
import {
  CRYSTAL_ARMOUR_BOW_IDS,
  type OrdinaryModifierInput,
  type OrdinaryModifierStages,
  ordinaryModifierStages,
} from './ordinaryAttackModifiers';
import { SOULREAPER_AXE_ID, SOULREAPER_MAX_STACKS } from './soulreaper';
import { getSpecialAttackDef, hasSpecialAttack } from './specialAttacks/registry';

const SCYTHE_IDS: ReadonlySet<number> = new Set([22325, 22486, 25736, 25738, 25739, 25741, 28543, 28545]);
const DUAL_MACUAHUITL_IDS: ReadonlySet<number> = new Set([28997, 29850]);
const DRAGON_CLAWS_IDS: ReadonlySet<number> = new Set([13652, 20784]);
const PURGING_STAFF_IDS: ReadonlySet<number> = new Set([29594]);
const SCORCHING_BOW_IDS: ReadonlySet<number> = new Set([29591]);
const BURNING_CLAWS_IDS: ReadonlySet<number> = new Set([29577]);
const ABYSSAL_BLUDGEON_IDS: ReadonlySet<number> = new Set([13263]);
/** Unmodeled dragonbane weapons that still fail closed against dragons (Dragon hunter wand spell passive). */
const DRAGONBANE_WEAPON_IDS: ReadonlySet<number> = new Set([30070]);
const ECLIPSE_ATLATL_IDS: ReadonlySet<number> = new Set([29000, 29851]);
const RUBY_BOLT_IDS: ReadonlySet<number> = new Set([9242, 21944]);
const DIAMOND_BOLT_IDS: ReadonlySet<number> = new Set([9243, 21946]);

const WHOLE: FormulaRatio = { numerator: 1, denominator: 1 };
const SLAYER_MELEE_BONUS: FormulaRatio = { numerator: 7, denominator: 6 };
const SLAYER_IMBUED_BONUS: FormulaRatio = { numerator: 23, denominator: 20 };
const HALF: FormulaRatio = { numerator: 1, denominator: 2 };
const QUARTER: FormulaRatio = { numerator: 1, denominator: 4 };
const NONE: FormulaRatio = { numerator: 0, denominator: 1 };
const DRAGON_DAGGER_MODIFIER: FormulaRatio = { numerator: 23, denominator: 20 };
const ABYSSAL_DAGGER_ACCURACY: FormulaRatio = { numerator: 5, denominator: 4 };
const ABYSSAL_DAGGER_MAX_HIT: FormulaRatio = { numerator: 17, denominator: 20 };
const THREE_HALVES: FormulaRatio = { numerator: 3, denominator: 2 };
const DOUBLE: FormulaRatio = { numerator: 2, denominator: 1 };
const BGS_MAX_HIT: FormulaRatio = { numerator: 121, denominator: 100 };
const AGS_MAX_HIT: FormulaRatio = { numerator: 11, denominator: 8 };
const EYE_OF_AYAK_MAX_HIT: FormulaRatio = { numerator: 13, denominator: 10 };
const SARADOMIN_GODSWORD_MAX_HIT: FormulaRatio = { numerator: 11, denominator: 10 };

const UNIMBUED_SLAYER_HELMET_IDS: ReadonlySet<number> = new Set([
  11864, 19639, 19643, 19647, 21264, 21888, 23073, 24370, 25898, 25904, 25910, 29816, 33066, 33338, 33340,
]);
const IMBUED_SLAYER_HELMET_IDS: ReadonlySet<number> = new Set([11865, 25177, 26674]);

const ORDINARY_ATTACK_PROFILE: PlayerAttackProfile = {
  kind: 'singleHit',
  maxHit: { kind: 'base' },
  hit: {
    accuracy: { kind: 'standard' },
    damage: { kind: 'uniformToMaxHit' },
  },
};

const DUAL_MACUAHUITL_PROFILE: PlayerAttackProfile = {
  kind: 'secondHitIfFirstAccurate',
  maxHit: { kind: 'base' },
  first: {
    accuracy: { kind: 'standard' },
    damage: {
      kind: 'uniformMaxHitFractionBounds',
      minimum: { ratio: { numerator: 0, denominator: 1 }, rounding: 'floor' },
      maximum: { ratio: HALF, rounding: 'floor' },
    },
  },
  second: {
    impactDelayOffsetTicks: 1,
    accuracy: { kind: 'standard' },
    damage: {
      kind: 'uniformMaxHitFractionBounds',
      minimum: { ratio: { numerator: 0, denominator: 1 }, rounding: 'ceiling' },
      maximum: { ratio: HALF, rounding: 'ceiling' },
    },
  },
};

const DRAGON_DAGGER_PROFILE = independentSpecialProfile(DRAGON_DAGGER_MODIFIER, DRAGON_DAGGER_MODIFIER);
const ABYSSAL_DAGGER_PROFILE = independentSpecialProfile(ABYSSAL_DAGGER_ACCURACY, ABYSSAL_DAGGER_MAX_HIT);
// /w/Dragon_warhammer (3 Oct 2026): Smash "deals 50% more damage"; no accuracy bonus.
const DRAGON_WARHAMMER_PROFILE: PlayerAttackProfile = {
  kind: 'singleHit',
  maxHit: { kind: 'staged', stages: [THREE_HALVES] },
  hit: { accuracy: { kind: 'standard' }, damage: { kind: 'uniformToMaxHit' } },
};
const BANDOS_GODSWORD_PROFILE = singleHitSpecialProfile(DOUBLE, BGS_MAX_HIT);
const ARMADYL_GODSWORD_PROFILE = singleHitSpecialProfile(ABYSSAL_DAGGER_ACCURACY, AGS_MAX_HIT);
const TOXIC_BLOWPIPE_PROFILE = singleHitSpecialProfile(DOUBLE, THREE_HALVES);
const ELDER_MAUL_PROFILE = singleHitSpecialProfile(ABYSSAL_DAGGER_ACCURACY);
const EYE_OF_AYAK_PROFILE = singleHitSpecialProfile(DOUBLE, EYE_OF_AYAK_MAX_HIT);
const SARADOMIN_GODSWORD_PROFILE = singleHitSpecialProfile(DOUBLE, SARADOMIN_GODSWORD_MAX_HIT);
const OSMUMTENS_FANG_ID = 26219;
/**
 * The fang's 15%, floored. /w/Osmumten's_fang states no rounding for either end of its 15-85% roll.
 * The ordinary roll's top is the max hit less this same amount, not a floored 85%: Eviscerate's
 * 100% splat shows a true max of 28 while ordinary swings cap at 24
 * (capture weapon-soulreaper-fang-dragonwarhammer-zombieaxe-noxhalberd-tridentoftheswamps-tridentoftheseas-packet-data.txt,
 * ticks 497-522), and the article's "true max hit was 60, it would roll between 9 and 51" agrees.
 * /w/Maximum_melee_hit lists the fang as a x0.85 multiplier, which floors 28 to 23; the capture
 * overrides it. The floored minimum fits both cases but is otherwise unverified.
 */
const FANG_TRIM: FormulaRatio = { numerator: 15, denominator: 100 };
const FANG_MINIMUM: FractionBound = { ratio: FANG_TRIM, rounding: 'floor' };
/**
 * Eviscerate (/w/Osmumten's_fang, rev of 5 Oct 2026): +50% accuracy, and damage rolls between 15%
 * and 100% of the true max hit, the passive's 85% cap lifted. The special is a stab, so the
 * passive's double accuracy roll applies.
 */
const EVISCERATE_PROFILE: PlayerAttackProfile = {
  kind: 'singleHit',
  maxHit: { kind: 'base' },
  hit: {
    accuracy: { kind: 'doubleRoll', attackRollStages: [THREE_HALVES] },
    damage: {
      kind: 'uniformMaxHitFractionBounds',
      minimum: FANG_MINIMUM,
      maximum: { ratio: WHOLE, rounding: 'floor' },
    },
  },
};
// /w/Accursed_sceptre#Special_attack: +50% accuracy and max hit.
const CONDEMN_PROFILE = singleHitSpecialProfile(THREE_HALVES, THREE_HALVES);
// /w/Abyssal_whip#Special_attack and /w/Dragon_scimitar#Special_attack: +25% accuracy.
const QUARTER_ACCURACY_PROFILE = singleHitSpecialProfile(ABYSSAL_DAGGER_ACCURACY);
// /w/Voidwaker#Special_attack: guaranteed magic damage from the ordinary MELEE max hit.
const VOIDWAKER_PROFILE: PlayerAttackProfile = {
  kind: 'singleHit',
  maxHit: { kind: 'base' },
  hit: {
    accuracy: { kind: 'guaranteed' },
    damage: {
      kind: 'uniformMaxHitFractionBounds',
      minimum: { ratio: HALF, rounding: 'floor' },
      maximum: { ratio: THREE_HALVES, rounding: 'floor' },
    },
  },
};

/**
 * /w/Burning_claws § Special attack: totals and shares floor independently, while offsets
 * transfer damage between splats and must not be folded into the fractions.
 */
const BURNING_BARRAGE_BRANCHES: NonEmptyReadonlyArray<AccuracyBranchProfile> = [
  {
    totalMinimum: { ratio: { numerator: 3, denominator: 4 }, rounding: 'floor' },
    totalMaximum: { ratio: { numerator: 7, denominator: 4 }, rounding: 'floor' },
    shares: [
      { fraction: { numerator: 1, denominator: 4 }, offset: 0 },
      { fraction: { numerator: 1, denominator: 4 }, offset: 0 },
      { fraction: { numerator: 1, denominator: 2 }, offset: 0 },
    ],
  },
  {
    totalMinimum: { ratio: { numerator: 1, denominator: 2 }, rounding: 'floor' },
    totalMaximum: { ratio: { numerator: 3, denominator: 2 }, rounding: 'floor' },
    shares: [
      { fraction: { numerator: 1, denominator: 2 }, offset: -1 },
      { fraction: { numerator: 1, denominator: 2 }, offset: -1 },
      { fraction: { numerator: 0, denominator: 1 }, offset: 2 },
    ],
  },
  {
    totalMinimum: { ratio: { numerator: 1, denominator: 4 }, rounding: 'floor' },
    totalMaximum: { ratio: { numerator: 5, denominator: 4 }, rounding: 'floor' },
    shares: [
      { fraction: { numerator: 0, denominator: 1 }, offset: 1 },
      { fraction: { numerator: 0, denominator: 1 }, offset: 1 },
      { fraction: { numerator: 1, denominator: 1 }, offset: -2 },
    ],
  },
];

/**
 * The wiki gives the all-miss case as a 20/40/40 split over 0, 1 and 2 total damage but never
 * says which hitsplat carries it, so the placement on the last splat is a guess and the weights
 * are not.
 */
const BURNING_BARRAGE_ALL_MISS: NonEmptyReadonlyArray<AllMissOutcomeProfile> = [
  { weight: 20, damages: [0, 0, 0] },
  { weight: 40, damages: [0, 0, 1] },
  { weight: 40, damages: [0, 0, 2] },
];

/**
 * /w/Dragon_claws § Special attack (rev 15186802), all fractions rounded down. The first attempt
 * to land rolls X, and the splats are X, X/2, X/4, X/4+1 ("4-2-1-1"), then 0, X, X/2, X/2+1,
 * 0, 0, X, X+1 and 0, 0, 0, X. Each branch's total is X, so every later splat is a floored share
 * of it; floor(X/4) equals the wiki's "half of the second" because nested floors agree.
 */
const SLICE_AND_DICE_BRANCHES: NonEmptyReadonlyArray<AccuracyBranchProfile> = [
  {
    // "its max hit will be 1 point less than the max hit of an ordinary attack"
    totalMinimum: { ratio: HALF, rounding: 'floor' },
    totalMaximum: { ratio: WHOLE, rounding: 'floor', offset: -1 },
    shares: [
      { fraction: WHOLE, offset: 0 },
      { fraction: HALF, offset: 0 },
      { fraction: QUARTER, offset: 0 },
      { fraction: QUARTER, offset: 1 },
    ],
  },
  {
    totalMinimum: { ratio: { numerator: 3, denominator: 8 }, rounding: 'floor' },
    totalMaximum: { ratio: { numerator: 7, denominator: 8 }, rounding: 'floor' },
    shares: [
      { fraction: NONE, offset: 0 },
      { fraction: WHOLE, offset: 0 },
      { fraction: HALF, offset: 0 },
      { fraction: HALF, offset: 1 },
    ],
  },
  {
    totalMinimum: { ratio: QUARTER, rounding: 'floor' },
    totalMaximum: { ratio: { numerator: 3, denominator: 4 }, rounding: 'floor' },
    shares: [
      { fraction: NONE, offset: 0 },
      { fraction: NONE, offset: 0 },
      { fraction: WHOLE, offset: 0 },
      { fraction: WHOLE, offset: 1 },
    ],
  },
  {
    totalMinimum: { ratio: QUARTER, rounding: 'floor' },
    totalMaximum: { ratio: { numerator: 5, denominator: 4 }, rounding: 'floor' },
    shares: [
      { fraction: NONE, offset: 0 },
      { fraction: NONE, offset: 0 },
      { fraction: NONE, offset: 0 },
      { fraction: WHOLE, offset: 0 },
    ],
  },
];

/** "a ~2/3 chance of dealing 2 damage (1-1-0-0, 0-0-1-1, 1-0-1-0, or 0-1-0-1) and a ~1/3 chance of 0-0-0-0" */
const SLICE_AND_DICE_ALL_MISS: NonEmptyReadonlyArray<AllMissOutcomeProfile> = [
  { weight: 2, damages: [0, 0, 0, 0] },
  { weight: 1, damages: [1, 1, 0, 0] },
  { weight: 1, damages: [0, 0, 1, 1] },
  { weight: 1, damages: [1, 0, 1, 0] },
  { weight: 1, damages: [0, 1, 0, 1] },
];

const SPECIAL_ATTACK_PROFILES: ReadonlyMap<number, PlayerAttackProfile> = new Map([
  [27665, CONDEMN_PROFILE],
  [27679, CONDEMN_PROFILE],
  [27676, CONDEMN_PROFILE],
  [27690, VOIDWAKER_PROFILE],
  // /w/Zamorak_godsword#Special_attack: double accuracy, +10% max hit.
  [11808, SARADOMIN_GODSWORD_PROFILE],
  [20374, SARADOMIN_GODSWORD_PROFILE],
  [4151, QUARTER_ACCURACY_PROFILE],
  [12773, QUARTER_ACCURACY_PROFILE],
  [12774, QUARTER_ACCURACY_PROFILE],
  [26482, QUARTER_ACCURACY_PROFILE],
  [4587, QUARTER_ACCURACY_PROFILE],
  [12006, ORDINARY_ATTACK_PROFILE],
  [26484, ORDINARY_ATTACK_PROFILE],
  [1215, DRAGON_DAGGER_PROFILE],
  [1231, DRAGON_DAGGER_PROFILE],
  [5680, DRAGON_DAGGER_PROFILE],
  [5698, DRAGON_DAGGER_PROFILE],
  [13265, ABYSSAL_DAGGER_PROFILE],
  [13267, ABYSSAL_DAGGER_PROFILE],
  [13269, ABYSSAL_DAGGER_PROFILE],
  [13271, ABYSSAL_DAGGER_PROFILE],
  [13576, DRAGON_WARHAMMER_PROFILE],
  [11804, BANDOS_GODSWORD_PROFILE],
  [20370, BANDOS_GODSWORD_PROFILE],
  [11802, ARMADYL_GODSWORD_PROFILE],
  [20368, ARMADYL_GODSWORD_PROFILE],
  [11806, SARADOMIN_GODSWORD_PROFILE],
  [20372, SARADOMIN_GODSWORD_PROFILE],
  [12926, TOXIC_BLOWPIPE_PROFILE],
  [21003, ELDER_MAUL_PROFILE],
  [27100, ELDER_MAUL_PROFILE],
  [31113, EYE_OF_AYAK_PROFILE],
  [OSMUMTENS_FANG_ID, EVISCERATE_PROFILE],
]);

export type PlayerAttackProfileSelectionInput = {
  readonly weaponId: number | undefined;
  readonly headId?: number | undefined;
  readonly bodyId?: number | undefined;
  readonly legsId?: number | undefined;
  readonly formulaStyle?: CombatFormulaStyle | undefined;
  readonly targetSize: number;
  readonly isSpecialAttack: boolean;
  readonly resources?: ResolvedAttackResources | undefined;
  readonly targetAttributes?: readonly string[] | undefined;
  readonly targetMagicLevel?: number | undefined;
  readonly targetMagicAttackBonus?: number | undefined;
  readonly targetCurrentHp?: number | undefined;
  readonly playerCurrentHp?: number | undefined;
  /** Prayer points below the player's Prayer level; drives the bludgeon's Penance. */
  readonly playerMissingPrayerPoints?: number | undefined;
  readonly markOfDarknessActive?: boolean | undefined;
  readonly demonbaneVulnerability?: number | undefined;
  /** Soulreaper axe soul stacks Behead would consume. */
  readonly soulreaperStacks?: number | undefined;
  /** The selected stance; a chinchompa's fuse. */
  readonly combatStyle?: CombatStyle | undefined;
  /** Chebyshev tiles to the target's nearest footprint tile; unknown leaves out distance modifiers. */
  readonly targetDistance?: number | undefined;
  /** Optional Twisted bow Magic scaling cap (250 outside raids, 350 in Chambers of Xeric). */
  readonly twistedBowMagicCap?: number | undefined;
};

export function selectPlayerAttackProfile(selection: PlayerAttackProfileSelectionInput): PlayerAttackProfile | null {
  const input = {
    ...selection,
    weaponId: selection.weaponId === undefined ? undefined : getEquipmentCombatBaseId(selection.weaponId),
  };
  const profile = selectBasePlayerAttackProfile(input);
  if (profile === null || profile.kind === 'unsupported') return profile;
  const withSlayer = withSlayerTaskBonus(profile, input);
  const inquisitor = inquisitorCrushBonus(input);
  return withChinchompaFuse(inquisitor === null ? withSlayer : appendGearBonus(withSlayer, inquisitor), input);
}

/** A chinchompa's fuse scales only the attack roll, after every gear bonus. */
function withChinchompaFuse(
  profile: PlayerAttackProfile,
  input: PlayerAttackProfileSelectionInput,
): PlayerAttackProfile {
  if (input.formulaStyle !== 'ranged' || input.targetDistance === undefined) return profile;
  const stage = chinchompaFuseAccuracy(input.weaponId, input.combatStyle, input.targetDistance);
  if (stage === null) return profile;
  if (profile.kind !== 'singleHit') throw new TypeError(`A chinchompa throw is a single hit, not ${profile.kind}`);
  return { ...profile, hit: { ...profile.hit, accuracy: appendAccuracyStage(profile.hit.accuracy, stage) } };
}

/**
 * Inquisitor's armour on a crush attack, per piece: great helm +0.5%, hauberk +1%, plateskirt +1%
 * accuracy and damage, so +2.5% for the full set (/w/Inquisitor's_armour; /w/Maximum_melee_hit lists
 * it as a 1.025 passive after Slayer and Salve). There is no set effect and no mace-specific boost
 * any more: both were folded into the pieces' and the mace's own stats.
 */
const INQUISITOR_CRUSH_PER_MILLE: ReadonlyMap<number, number> = new Map([
  [24419, 5],
  [24420, 10],
  [24421, 10],
]);

function inquisitorCrushBonus(input: PlayerAttackProfileSelectionInput): FormulaRatio | null {
  if (input.formulaStyle !== 'melee_crush') return null;
  const perMille = [input.headId, input.bodyId, input.legsId].reduce<number>(
    (sum, id) => sum + (id === undefined ? 0 : (INQUISITOR_CRUSH_PER_MILLE.get(id) ?? 0)),
    0,
  );
  return perMille === 0 ? null : { numerator: 1000 + perMille, denominator: 1000 };
}

function withSlayerTaskBonus(
  profile: PlayerAttackProfile,
  input: PlayerAttackProfileSelectionInput,
): PlayerAttackProfile {
  const bonus = slayerTaskBonus(input.headId, input.formulaStyle, input.weaponId);
  if (bonus === null) return profile;
  if (
    input.weaponId !== undefined &&
    SCORCHING_BOW_IDS.has(input.weaponId) &&
    input.targetAttributes?.includes('demon') === true
  ) {
    return addScorchingBowSlayerBonus(profile, bonus);
  }
  // The crystal armour bonus is already in the profile, and the helmet multiplies it.
  return input.weaponId !== undefined && CRYSTAL_ARMOUR_BOW_IDS.has(getEquipmentCombatBaseId(input.weaponId))
    ? appendGearBonus(profile, bonus)
    : prependGearBonus(profile, bonus);
}

function selectBasePlayerAttackProfile(input: PlayerAttackProfileSelectionInput): PlayerAttackProfile | null {
  if (input.isSpecialAttack) {
    if (input.weaponId === undefined) return null;
    if (getSpecialAttackDef(input.weaponId)?.instantEffect !== undefined) return null;
    if (ECLIPSE_ATLATL_IDS.has(input.weaponId))
      return { kind: 'unsupported', gaps: [CALC_GAPS.ECLIPSE_SPECIAL_FORMULA] };
    if (input.weaponId === 29589) return ordinaryProfileWithModifiers(input);
    // "Scatter ashes uses the best demonbane spell the player can cast" (/w/Purging_staff), so its
    // damage is the ordinary cast rather than a multiplier of it; the refund and the 3-tick
    // reduction are the whole of the special, and they live in the registry's onKillEffect.
    if (PURGING_STAFF_IDS.has(input.weaponId)) return ordinaryProfileWithModifiers(input);
    // The Scorching bow special carries no damage modifier of its own: the bind and the burn in
    // the registry are the whole special, so refusing it here would silently drop both.
    if (SCORCHING_BOW_IDS.has(input.weaponId)) return ORDINARY_ATTACK_PROFILE;
    if (BURNING_CLAWS_IDS.has(input.weaponId)) {
      // Burning barrage uses the weapon's ordinary max hit and accuracy, including demonbane.
      return clawSpecialProfile(input, BURNING_BARRAGE_BRANCHES, BURNING_BARRAGE_ALL_MISS);
    }
    // Slice and Dice: "Each of the four attacks has the same accuracy as an ordinary attack".
    if (DRAGON_CLAWS_IDS.has(input.weaponId)) {
      return clawSpecialProfile(input, SLICE_AND_DICE_BRANCHES, SLICE_AND_DICE_ALL_MISS);
    }
    if (ABYSSAL_BLUDGEON_IDS.has(input.weaponId)) return penanceProfile(input.playerMissingPrayerPoints ?? 0);
    if (input.weaponId === SOULREAPER_AXE_ID) return beheadProfile(input.soulreaperStacks ?? 0);
    const readyProfile = SPECIAL_ATTACK_PROFILES.get(input.weaponId);
    if (readyProfile !== undefined) return readyProfile;
    return hasSpecialAttack(input.weaponId) ? { kind: 'unsupported', gaps: [CALC_GAPS.ANIMATION_ONLY_SPECIAL] } : null;
  }
  if (input.resources?.kind === 'spell') return ordinaryProfileWithModifiers(input);
  if (hasUnsupportedOrdinaryModifier(input)) return null;
  if (input.weaponId === OSMUMTENS_FANG_ID) return fangOrdinaryProfile(input);
  if (input.weaponId === undefined) return ORDINARY_ATTACK_PROFILE;
  if (!SCYTHE_IDS.has(input.weaponId) && !DUAL_MACUAHUITL_IDS.has(input.weaponId)) {
    return ordinaryProfileWithModifiers(input);
  }
  if (SCYTHE_IDS.has(input.weaponId)) {
    return {
      kind: 'independentMultiHit',
      maxHit: { kind: 'base' },
      accuracy: { kind: 'standard' },
      maximumFractions: selectScytheMaximumFractions(input.targetSize),
    };
  }
  if (DUAL_MACUAHUITL_IDS.has(input.weaponId)) return DUAL_MACUAHUITL_PROFILE;
  return ORDINARY_ATTACK_PROFILE;
}

function slayerTaskBonus(
  headId: number | undefined,
  formulaStyle: CombatFormulaStyle | undefined,
  weaponId: number | undefined,
): FormulaRatio | null {
  if (headId === undefined || formulaStyle === undefined) return null;
  const canonicalId = getEquipmentCombatBaseId(headId);
  if (formulaStyle.startsWith('melee_') || (weaponId !== undefined && ECLIPSE_ATLATL_IDS.has(weaponId))) {
    return UNIMBUED_SLAYER_HELMET_IDS.has(canonicalId) || IMBUED_SLAYER_HELMET_IDS.has(canonicalId)
      ? SLAYER_MELEE_BONUS
      : null;
  }
  return IMBUED_SLAYER_HELMET_IDS.has(canonicalId) ? SLAYER_IMBUED_BONUS : null;
}

function prependGearBonus(profile: PlayerAttackProfile, bonus: FormulaRatio): PlayerAttackProfile {
  switch (profile.kind) {
    case 'singleHit':
      return {
        ...profile,
        maxHit: prependMaxHitStage(profile.maxHit, bonus),
        hit: { ...profile.hit, accuracy: prependAccuracyStage(profile.hit.accuracy, bonus) },
      };
    case 'independentMultiHit':
      return {
        ...profile,
        maxHit: prependMaxHitStage(profile.maxHit, bonus),
        accuracy: prependAccuracyStage(profile.accuracy, bonus),
      };
    case 'secondHitIfFirstAccurate':
      return {
        ...profile,
        maxHit: prependMaxHitStage(profile.maxHit, bonus),
        first: { ...profile.first, accuracy: prependAccuracyStage(profile.first.accuracy, bonus) },
        second: { ...profile.second, accuracy: prependAccuracyStage(profile.second.accuracy, bonus) },
      };
    case 'priorDamageHits':
      return {
        ...profile,
        maxHit: prependMaxHitStage(profile.maxHit, bonus),
        first: { ...profile.first, accuracy: prependAccuracyStage(profile.first.accuracy, bonus) },
      };
    case 'accuracyBranchedSplit':
      return {
        ...profile,
        maxHit: prependMaxHitStage(profile.maxHit, bonus),
        accuracy: prependAccuracyStage(profile.accuracy, bonus),
      };
    case 'unsupported':
      return profile;
    default:
      return assertNever(profile);
  }
}

function appendGearBonus(profile: PlayerAttackProfile, bonus: FormulaRatio): PlayerAttackProfile {
  switch (profile.kind) {
    case 'singleHit':
      return {
        ...profile,
        maxHit: appendMaxHitStage(profile.maxHit, bonus),
        hit: { ...profile.hit, accuracy: appendAccuracyStage(profile.hit.accuracy, bonus) },
      };
    case 'independentMultiHit':
      return {
        ...profile,
        maxHit: appendMaxHitStage(profile.maxHit, bonus),
        accuracy: appendAccuracyStage(profile.accuracy, bonus),
      };
    case 'secondHitIfFirstAccurate':
      return {
        ...profile,
        maxHit: appendMaxHitStage(profile.maxHit, bonus),
        first: { ...profile.first, accuracy: appendAccuracyStage(profile.first.accuracy, bonus) },
        second: { ...profile.second, accuracy: appendAccuracyStage(profile.second.accuracy, bonus) },
      };
    case 'priorDamageHits':
      return {
        ...profile,
        maxHit: appendMaxHitStage(profile.maxHit, bonus),
        first: { ...profile.first, accuracy: appendAccuracyStage(profile.first.accuracy, bonus) },
      };
    case 'accuracyBranchedSplit':
      return {
        ...profile,
        maxHit: appendMaxHitStage(profile.maxHit, bonus),
        accuracy: appendAccuracyStage(profile.accuracy, bonus),
      };
    case 'unsupported':
      return profile;
    default:
      return assertNever(profile);
  }
}

function prependMaxHitStage(profile: MaxHitProfile, bonus: FormulaRatio): MaxHitProfile {
  return profile.kind === 'base'
    ? { kind: 'staged', stages: [bonus] }
    : { kind: 'staged', stages: [bonus, ...profile.stages] };
}

function appendMaxHitStage(profile: MaxHitProfile, bonus: FormulaRatio): MaxHitProfile {
  return profile.kind === 'base'
    ? { kind: 'staged', stages: [bonus] }
    : { kind: 'staged', stages: [...profile.stages, bonus] };
}

function prependAccuracyStage(profile: FormulaAccuracyProfile, bonus: FormulaRatio): FormulaAccuracyProfile {
  switch (profile.kind) {
    case 'standard':
    case 'doubleRoll':
      return { ...profile, attackRollStages: [bonus, ...(profile.attackRollStages ?? [])] };
    case 'guaranteed':
      return profile;
    default:
      return assertNever(profile);
  }
}

function appendAccuracyStage(profile: FormulaAccuracyProfile, bonus: FormulaRatio): FormulaAccuracyProfile {
  switch (profile.kind) {
    case 'standard':
    case 'doubleRoll':
      return { ...profile, attackRollStages: [...(profile.attackRollStages ?? []), bonus] };
    case 'guaranteed':
      return profile;
    default:
      return assertNever(profile);
  }
}

function addScorchingBowSlayerBonus(profile: PlayerAttackProfile, bonus: FormulaRatio): PlayerAttackProfile {
  if (
    profile.kind !== 'singleHit' ||
    profile.maxHit.kind !== 'staged' ||
    profile.maxHit.stages.length !== 1 ||
    profile.hit.accuracy.kind !== 'standard' ||
    profile.hit.accuracy.attackRollStages?.length !== 1
  ) {
    return prependGearBonus(profile, bonus);
  }
  const maxHitStage = addPercentageBonuses(profile.maxHit.stages[0], bonus);
  return {
    ...profile,
    maxHit: { kind: 'staged', stages: [maxHitStage] },
    hit: {
      ...profile.hit,
      accuracy: prependAccuracyStage(profile.hit.accuracy, bonus),
    },
  };
}

function addPercentageBonuses(first: FormulaRatio, second: FormulaRatio): FormulaRatio {
  const denominator = first.denominator * second.denominator;
  const numerator = first.numerator * second.denominator + second.numerator * first.denominator - denominator;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function greatestCommonDivisor(first: number, second: number): number {
  let left = Math.abs(first);
  let right = Math.abs(second);
  while (right !== 0) {
    [left, right] = [right, left % right];
  }
  return left;
}
// No shipped encounter carries the dragon attribute, so this branch looks dead: deleting it makes
// dragonbane weapons roll a plausible-but-wrong plain hit instead of failing closed.
function hasUnsupportedOrdinaryModifier(input: PlayerAttackProfileSelectionInput): boolean {
  const attributes = input.targetAttributes ?? [];
  return input.weaponId !== undefined && attributes.includes('dragon') && DRAGONBANE_WEAPON_IDS.has(input.weaponId);
}

function toOrdinaryModifierInput(input: PlayerAttackProfileSelectionInput): OrdinaryModifierInput {
  return {
    weaponId: input.weaponId,
    headId: input.headId,
    bodyId: input.bodyId,
    legsId: input.legsId,
    resources: input.resources,
    targetAttributes: input.targetAttributes ?? [],
    targetMagicLevel: input.targetMagicLevel ?? 0,
    targetMagicAttackBonus: input.targetMagicAttackBonus ?? 0,
    markOfDarknessActive: input.markOfDarknessActive ?? false,
    demonbaneVulnerability: input.demonbaneVulnerability ?? 1,
    twistedBowMagicCap: input.twistedBowMagicCap,
  };
}

function ordinaryProfileWithModifiers(input: PlayerAttackProfileSelectionInput): PlayerAttackProfile {
  const stages = ordinaryModifierStages(toOrdinaryModifierInput(input));

  return {
    kind: 'singleHit',
    maxHit: toMaxHitProfile(stages.maxHitStages),
    hit: {
      accuracy: toAccuracyProfile(stages.attackRollStages),
      damage: { kind: 'uniformToMaxHit' },
      ...enchantedBoltProc(input),
    },
  };
}

function enchantedBoltProc(input: PlayerAttackProfileSelectionInput): Pick<HitRollProfile, 'proc'> {
  const ammoId = input.resources?.kind === 'ammo' ? getCanonicalEquipmentItemId(input.resources.ammoId) : undefined;
  if (
    ammoId !== undefined &&
    RUBY_BOLT_IDS.has(ammoId) &&
    input.targetCurrentHp !== undefined &&
    input.playerCurrentHp !== undefined &&
    input.playerCurrentHp >= 10
  ) {
    return {
      proc: {
        kind: 'rubyBolt',
        chancePercent: 6,
        targetCurrentHp: input.targetCurrentHp,
      },
    };
  }
  if (ammoId !== undefined && DIAMOND_BOLT_IDS.has(ammoId)) {
    return { proc: { kind: 'diamondBolt', chancePercent: 10 } };
  }
  return {};
}

function toMaxHitProfile(stages: OrdinaryModifierStages['maxHitStages']): MaxHitProfile {
  const [first, ...rest] = stages;
  return first === undefined ? { kind: 'base' } : { kind: 'staged', stages: [first, ...rest] };
}

function toAccuracyProfile(stages: OrdinaryModifierStages['attackRollStages']): FormulaAccuracyProfile {
  return stages.length === 0 ? { kind: 'standard' } : { kind: 'standard', attackRollStages: stages };
}

/** A claw special: the weapon's ordinary max hit and accuracy, split by which attempt lands first. */
function clawSpecialProfile(
  input: PlayerAttackProfileSelectionInput,
  branches: NonEmptyReadonlyArray<AccuracyBranchProfile>,
  allMiss: NonEmptyReadonlyArray<AllMissOutcomeProfile>,
): PlayerAttackProfile {
  const stages = ordinaryModifierStages(toOrdinaryModifierInput(input));
  return {
    kind: 'accuracyBranchedSplit',
    maxHit: toMaxHitProfile(stages.maxHitStages),
    accuracy: toAccuracyProfile(stages.attackRollStages),
    branches,
    allMiss,
  };
}

/**
 * The fang's passive outside the Tombs of Amascut (/w/Osmumten's_fang, rev of 19 Jun 2026): a stab
 * makes "two independent accuracy rolls ... if either is higher than the opponent's original defence
 * roll, the attack succeeds", and a hit "with any attack type" rolls 15-85% of the max hit. Slash
 * and crush styles keep the single roll. ToA's variant is not modeled.
 */
function fangOrdinaryProfile(input: PlayerAttackProfileSelectionInput): PlayerAttackProfile {
  const stages = ordinaryModifierStages(toOrdinaryModifierInput(input));
  const attackRollStages = stages.attackRollStages;
  return {
    kind: 'singleHit',
    maxHit: toMaxHitProfile(stages.maxHitStages),
    hit: {
      accuracy:
        input.formulaStyle === 'melee_stab'
          ? attackRollStages.length === 0
            ? { kind: 'doubleRoll' }
            : { kind: 'doubleRoll', attackRollStages }
          : toAccuracyProfile(attackRollStages),
      damage: { kind: 'uniformTrimmedMaxHit', trim: FANG_TRIM },
    },
  };
}

/**
 * Behead (/w/Soulreaper_axe, rev of 2 Oct 2026): per stack consumed, +12% accuracy, +6% max hit
 * and a minimum hit of 6% of that max hit. The stacks' Strength boost is spent before the max hit
 * is worked out, so the caller plans it from the un-stacked Strength level. The wiki is silent on
 * Behead at zero stacks; it is taken as an ordinary hit with no bonus. The minimum floors, which
 * the wiki does not state.
 */
function beheadProfile(soulStacks: number): PlayerAttackProfile {
  const stacks = Math.min(SOULREAPER_MAX_STACKS, Math.max(0, Math.floor(soulStacks)));
  if (stacks === 0) return ORDINARY_ATTACK_PROFILE;
  return {
    kind: 'singleHit',
    maxHit: { kind: 'staged', stages: [{ numerator: 100 + 6 * stacks, denominator: 100 }] },
    hit: {
      accuracy: { kind: 'standard', attackRollStages: [{ numerator: 100 + 12 * stacks, denominator: 100 }] },
      damage: {
        kind: 'uniformMaxHitFractionBounds',
        minimum: { ratio: { numerator: 6 * stacks, denominator: 100 }, rounding: 'floor' },
        maximum: { ratio: WHOLE, rounding: 'floor' },
      },
    },
  };
}

function independentSpecialProfile(attackRollStage: FormulaRatio, maxHitStage: FormulaRatio): PlayerAttackProfile {
  return {
    kind: 'independentMultiHit',
    maxHit: { kind: 'staged', stages: [maxHitStage] },
    accuracy: { kind: 'standard', attackRollStages: [attackRollStage] },
    maximumFractions: [WHOLE, WHOLE],
  };
}

/**
 * Penance: "increases damage dealt by 0.5% for every prayer point that the wielder is missing"
 * (/w/Abyssal_bludgeon § Special attack, rev 15186994), a max-hit multiplier of
 * 1.0 + 0.005 x missing points with no accuracy change (/w/Maximum_melee_hit, rev 15292108;
 * /w/Special_attacks rev 15350782 lists no attack roll modifier).
 */
function penanceProfile(missingPrayerPoints: number): PlayerAttackProfile {
  const missing = Math.max(0, Math.floor(missingPrayerPoints));
  return {
    kind: 'singleHit',
    maxHit: { kind: 'staged', stages: [{ numerator: 200 + missing, denominator: 200 }] },
    hit: { accuracy: { kind: 'standard' }, damage: { kind: 'uniformToMaxHit' } },
  };
}

function singleHitSpecialProfile(attackRollStage: FormulaRatio, maxHitStage?: FormulaRatio): PlayerAttackProfile {
  return {
    kind: 'singleHit',
    maxHit: maxHitStage === undefined ? { kind: 'base' } : { kind: 'staged', stages: [maxHitStage] },
    hit: {
      accuracy: { kind: 'standard', attackRollStages: [attackRollStage] },
      damage: { kind: 'uniformToMaxHit' },
    },
  };
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled player attack profile: ${JSON.stringify(value)}`);
}

function selectScytheMaximumFractions(targetSize: number): readonly [FormulaRatio, ...FormulaRatio[]] {
  if (targetSize === 1) return [WHOLE];
  if (targetSize === 2) return [WHOLE, HALF];
  return [WHOLE, HALF, QUARTER];
}
