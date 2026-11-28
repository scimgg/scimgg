import { PRAYER_STAT_MULTIPLIERS, type PrayerType } from '../../types/simulation';
import { DEFAULT_PRAYER_MULTIPLIERS, type PrayerMultipliers } from './formulaTypes';

/**
 * Two lit prayers that boost the same stat add their percentages. Deadeye or Mystic Vigour with a
 * skin prayer is the only such pair the conflict table allows: "The defence boost with multiple
 * prayers is additive" (https://oldschool.runescape.wiki/w/Deadeye?oldid=15222979).
 *
 * The sum is rounded to the table's whole-hundredth precision so it is the same double as the
 * written multiplier: `1 + (1.23 - 1)` can land a hair below 1.23, and the formulas floor
 * `level * multiplier`.
 */
function addBoost(current: number, boost: number | undefined): number {
  if (boost === undefined) return current;
  return Math.round((current + boost - 1) * 10000) / 10000;
}

export function lookupPrayerMultipliers(activePrayers: readonly (PrayerType | null | undefined)[]): PrayerMultipliers {
  let multipliers = DEFAULT_PRAYER_MULTIPLIERS;

  for (const prayer of activePrayers) {
    if (prayer === null || prayer === undefined) continue;
    const boost = PRAYER_STAT_MULTIPLIERS[prayer];
    if (boost === undefined) continue;
    multipliers = {
      attack: addBoost(multipliers.attack, boost.attack),
      strength: addBoost(multipliers.strength, boost.strength),
      defence: addBoost(multipliers.defence, boost.defence),
      ranged: addBoost(multipliers.ranged, boost.ranged),
      rangedStrength: addBoost(multipliers.rangedStrength, boost.rangedStrength),
      magic: addBoost(multipliers.magic, boost.magic),
      magicDamage: addBoost(multipliers.magicDamage, boost.magicDamage),
    };
  }

  return multipliers;
}

export function lookupPrayerMultipliersFromState(
  activePrayer: PrayerType | null,
  boostPrayers: readonly PrayerType[],
): PrayerMultipliers {
  return lookupPrayerMultipliers([activePrayer, ...boostPrayers]);
}
