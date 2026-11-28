/**
 * Transcribed from the OSRS Wiki's Prayer article, revision 15411470
 * (https://oldschool.runescape.wiki/w/Prayer?oldid=15411470): the prayer table's "Drain effect"
 * and "Effect" columns for the tiered prayers and Chivalry, and the "Conflicting prayers" table.
 * CC BY-NC-SA 3.0, see THIRD_PARTY_NOTICES.md.
 *
 * Written out by hand from the article, never derived from the code under test.
 */
import { type PrayerBoostMultipliers, PrayerType } from '../../simulation';

export interface WikiPrayerRow {
  readonly prayer: PrayerType;
  /** The "Level" column. */
  readonly level: number;
  /** The "Drain effect" column. */
  readonly drainEffect: number;
  /** The "Effect" column, as multipliers in the `PrayerBoostMultipliers` sense. */
  readonly boost: PrayerBoostMultipliers;
}

export const WIKI_TIERED_PRAYER_ROWS: readonly WikiPrayerRow[] = [
  // "+5% Defence"
  { prayer: PrayerType.ThickSkin, level: 1, drainEffect: 1, boost: { defence: 1.05 } },
  // "+5% Strength"
  { prayer: PrayerType.BurstOfStrength, level: 4, drainEffect: 1, boost: { strength: 1.05 } },
  // "+5% Attack"
  { prayer: PrayerType.ClarityOfThought, level: 7, drainEffect: 1, boost: { attack: 1.05 } },
  // "+5% Ranged attack and +5% Ranged Strength"
  { prayer: PrayerType.SharpEye, level: 8, drainEffect: 1, boost: { ranged: 1.05, rangedStrength: 1.05 } },
  // "+5% Magic Attack and Defence"
  { prayer: PrayerType.MysticWill, level: 9, drainEffect: 1, boost: { magic: 1.05 } },
  // "+10% Defence"
  { prayer: PrayerType.RockSkin, level: 10, drainEffect: 6, boost: { defence: 1.1 } },
  // "+10% Strength"
  { prayer: PrayerType.SuperhumanStrength, level: 13, drainEffect: 6, boost: { strength: 1.1 } },
  // "+10% Attack"
  { prayer: PrayerType.ImprovedReflexes, level: 16, drainEffect: 6, boost: { attack: 1.1 } },
  // "+10% Ranged Attack and +10% Ranged Strength"
  { prayer: PrayerType.HawkEye, level: 26, drainEffect: 6, boost: { ranged: 1.1, rangedStrength: 1.1 } },
  // "+10% Magic Attack and Defence. +1% Magic damage"
  { prayer: PrayerType.MysticLore, level: 27, drainEffect: 6, boost: { magic: 1.1, magicDamage: 1.01 } },
  // "+15% Defence"
  { prayer: PrayerType.SteelSkin, level: 28, drainEffect: 12, boost: { defence: 1.15 } },
  // "+15% Strength"
  { prayer: PrayerType.UltimateStrength, level: 31, drainEffect: 12, boost: { strength: 1.15 } },
  // "+15% Attack"
  { prayer: PrayerType.IncredibleReflexes, level: 34, drainEffect: 12, boost: { attack: 1.15 } },
  // "+15% Attack, +18% Strength, and +20% Defence"
  { prayer: PrayerType.Chivalry, level: 60, drainEffect: 12, boost: { attack: 1.15, strength: 1.18, defence: 1.2 } },
];

export type WikiConflictRow = 'defence' | 'strength' | 'attack' | 'overhead';

/**
 * Each cell of the conflict table and the rows it spans. Two prayers conflict when their cells
 * share a row. Protect Item, Retribution and Smite are in the table but not modeled, so absent.
 */
export const WIKI_CONFLICT_CELLS: readonly {
  readonly rows: readonly WikiConflictRow[];
  readonly prayers: readonly PrayerType[];
}[] = [
  // "Defence Boosting Prayers", footnote a: "Deadeye and Mystic Vigour boost defence, but do not
  // conflict with the three basic Defence prayers".
  { rows: ['defence'], prayers: [PrayerType.ThickSkin, PrayerType.RockSkin, PrayerType.SteelSkin] },
  // rowspan=3: the defence row and both "Offence Boosting Prayers" rows.
  {
    rows: ['defence', 'strength', 'attack'],
    prayers: [PrayerType.Chivalry, PrayerType.Piety, PrayerType.Zeal, PrayerType.Rigour, PrayerType.Augury],
  },
  {
    rows: ['strength'],
    prayers: [PrayerType.BurstOfStrength, PrayerType.SuperhumanStrength, PrayerType.UltimateStrength],
  },
  // rowspan=2: both offence rows.
  {
    rows: ['strength', 'attack'],
    prayers: [
      PrayerType.SharpEye,
      PrayerType.HawkEye,
      PrayerType.EagleEye,
      PrayerType.Deadeye,
      PrayerType.MysticWill,
      PrayerType.MysticLore,
      PrayerType.MysticMight,
      PrayerType.MysticVigour,
    ],
  },
  {
    rows: ['attack'],
    prayers: [PrayerType.ClarityOfThought, PrayerType.ImprovedReflexes, PrayerType.IncredibleReflexes],
  },
  // "Overhead Prayers"
  {
    rows: ['overhead'],
    prayers: [PrayerType.ProtectMagic, PrayerType.ProtectRange, PrayerType.ProtectMelee, PrayerType.Redemption],
  },
];

/** "The only prayers without conflicting prayers", less the unmodeled Protect Item. */
export const WIKI_UNCONFLICTED_PRAYERS: readonly PrayerType[] = [
  PrayerType.RapidRestore,
  PrayerType.RapidHeal,
  PrayerType.Preserve,
];
