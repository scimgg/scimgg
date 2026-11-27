import type { PrayerFilterOptions } from '../../types/panelFilters';
import { isPrayerUnlocked, PrayerType, type PrayerUnlocks } from '../../types/simulation';

/**
 * Which tier ladder a prayer sits on.
 *
 * The filter's whole point turns on comparing two prayers' groups: a successor in
 * the SAME group is the ordinary next tier of one skill, while a successor in a
 * different group is the multi-skill jump that only the second filter row
 * suppresses (https://oldschool.runescape.wiki/w/Prayer#Prayer_filtering).
 */
export type PrayerTierGroup =
  | 'attack'
  | 'strength'
  | 'defence'
  | 'ranged'
  | 'magic'
  | 'melee-combined'
  | 'ranged-combined'
  | 'magic-combined';

/**
 * Non-Prayer stat gates, per each prayer's wiki page. Unlock prerequisites (quests,
 * scrolls) are not modeled beyond the account-unlock toggles: the book treats them
 * as earned, as an account that has them would see it.
 */
interface PrayerStatRequirements {
  defenceLevel?: number;
  attackLevel?: number;
  strengthLevel?: number;
}

export interface PrayerUpgrade extends PrayerStatRequirements {
  icon: string;
  label: string;
  level: number;
  prayer: PrayerType;
}

export interface PrayerSlot extends PrayerStatRequirements {
  icon: string;
  label: string;
  prayer?: PrayerType;
  upgrade?: PrayerUpgrade;
  /** Prayer level the prayer needs — the cache's `param_1753`. */
  level: number;
  /** The cache's `param_1758`: the flag the "Show Rapid Healing prayers" row reads. */
  healing?: true;
  /** See {@link PrayerTierGroup}. Absent for a prayer that is on no ladder. */
  tierGroup?: PrayerTierGroup;
  /** Icon name of the next prayer up this ladder. */
  successor?: string;
}

export const PRAYER_GRID: PrayerSlot[] = [
  {
    icon: 'thick_skin',
    label: 'Thick Skin',
    level: 1,
    prayer: PrayerType.ThickSkin,
    tierGroup: 'defence',
    successor: 'rock_skin',
  },
  {
    icon: 'burst_of_strength',
    label: 'Burst of Strength',
    level: 4,
    prayer: PrayerType.BurstOfStrength,
    tierGroup: 'strength',
    successor: 'superhuman_strength',
  },
  {
    icon: 'clarity_of_thought',
    label: 'Clarity of Thought',
    level: 7,
    prayer: PrayerType.ClarityOfThought,
    tierGroup: 'attack',
    successor: 'improved_reflexes',
  },
  {
    icon: 'sharp_eye',
    label: 'Sharp Eye',
    level: 8,
    prayer: PrayerType.SharpEye,
    tierGroup: 'ranged',
    successor: 'hawk_eye',
  },
  {
    icon: 'mystic_will',
    label: 'Mystic Will',
    level: 9,
    prayer: PrayerType.MysticWill,
    tierGroup: 'magic',
    successor: 'mystic_lore',
  },

  {
    icon: 'rock_skin',
    label: 'Rock Skin',
    level: 10,
    prayer: PrayerType.RockSkin,
    tierGroup: 'defence',
    successor: 'steel_skin',
  },
  {
    icon: 'superhuman_strength',
    label: 'Superhuman Strength',
    level: 13,
    prayer: PrayerType.SuperhumanStrength,
    tierGroup: 'strength',
    successor: 'ultimate_strength',
  },
  {
    icon: 'improved_reflexes',
    label: 'Improved Reflexes',
    level: 16,
    prayer: PrayerType.ImprovedReflexes,
    tierGroup: 'attack',
    successor: 'incredible_reflexes',
  },
  { icon: 'rapid_restore', label: 'Rapid Restore', level: 19, prayer: PrayerType.RapidRestore, healing: true },
  { icon: 'rapid_heal', label: 'Rapid Heal', level: 22, prayer: PrayerType.RapidHeal, healing: true },

  { icon: 'protect_item', label: 'Protect Item', level: 25 },
  {
    icon: 'hawk_eye',
    label: 'Hawk Eye',
    level: 26,
    prayer: PrayerType.HawkEye,
    tierGroup: 'ranged',
    successor: 'eagle_eye',
  },
  {
    icon: 'mystic_lore',
    label: 'Mystic Lore',
    level: 27,
    prayer: PrayerType.MysticLore,
    tierGroup: 'magic',
    successor: 'mystic_might',
  },
  {
    icon: 'steel_skin',
    label: 'Steel Skin',
    level: 28,
    prayer: PrayerType.SteelSkin,
    tierGroup: 'defence',
    successor: 'chivalry',
  },
  {
    icon: 'ultimate_strength',
    label: 'Ultimate Strength',
    level: 31,
    prayer: PrayerType.UltimateStrength,
    tierGroup: 'strength',
    successor: 'chivalry',
  },

  {
    icon: 'incredible_reflexes',
    label: 'Incredible Reflexes',
    level: 34,
    prayer: PrayerType.IncredibleReflexes,
    tierGroup: 'attack',
    successor: 'chivalry',
  },
  { icon: 'protect_from_magic', label: 'Protect from Magic', level: 37, prayer: PrayerType.ProtectMagic },
  { icon: 'protect_from_missiles', label: 'Protect from Missiles', level: 40, prayer: PrayerType.ProtectRange },
  { icon: 'protect_from_melee', label: 'Protect from Melee', level: 43, prayer: PrayerType.ProtectMelee },
  {
    icon: 'eagle_eye',
    label: 'Eagle Eye',
    level: 44,
    prayer: PrayerType.EagleEye,
    tierGroup: 'ranged',
    successor: 'rigour',
    upgrade: { icon: 'deadeye', label: 'Deadeye', level: 62, prayer: PrayerType.Deadeye },
  },

  {
    icon: 'mystic_might',
    label: 'Mystic Might',
    level: 45,
    prayer: PrayerType.MysticMight,
    tierGroup: 'magic',
    successor: 'augury',
    upgrade: { icon: 'mystic_vigour', label: 'Mystic Vigour', level: 63, prayer: PrayerType.MysticVigour },
  },
  { icon: 'retribution', label: 'Retribution', level: 46 },
  { icon: 'redemption', label: 'Redemption', level: 49, prayer: PrayerType.Redemption },
  { icon: 'smite', label: 'Smite', level: 52 },
  { icon: 'preserve', label: 'Preserve', level: 55, prayer: PrayerType.Preserve },

  {
    icon: 'chivalry',
    label: 'Chivalry',
    level: 60,
    prayer: PrayerType.Chivalry,
    tierGroup: 'melee-combined',
    successor: 'piety',
    defenceLevel: 65,
  },
  {
    icon: 'piety',
    label: 'Piety',
    level: 70,
    prayer: PrayerType.Piety,
    tierGroup: 'melee-combined',
    defenceLevel: 70,
    // https://oldschool.runescape.wiki/w/Zeal
    upgrade: { icon: 'zeal', label: 'Zeal', level: 84, prayer: PrayerType.Zeal, attackLevel: 75, strengthLevel: 75 },
  },
  {
    icon: 'rigour',
    label: 'Rigour',
    level: 74,
    prayer: PrayerType.Rigour,
    tierGroup: 'ranged-combined',
    defenceLevel: 70,
  },
  {
    icon: 'augury',
    label: 'Augury',
    level: 77,
    prayer: PrayerType.Augury,
    tierGroup: 'magic-combined',
    defenceLevel: 70,
  },
];

const PRAYER_BY_ICON = new Map(PRAYER_GRID.map((slot) => [slot.icon, slot]));

export const PRAYER_SLOT_ICON_NAMES: readonly string[] = PRAYER_GRID.flatMap((slot) =>
  slot.upgrade ? [slot.icon, slot.upgrade.icon] : [slot.icon],
);

/**
 * The account levels the prayer filters read. All are BASE levels, so a Prayer
 * potion never reveals a prayer you have not trained to and drained Prayer never
 * hides one. Not settled by a permitted public source; it is the behavior this simulator
 * assumes and the one thing here a live-client check should confirm before it is relied on.
 */
export interface PrayerAvailability {
  basePrayerLevel: number;
  baseDefenceLevel: number;
  baseAttackLevel: number;
  baseStrengthLevel: number;
}

/** No stats configured yet, so nothing is gated. */
const UNGATED: PrayerAvailability = {
  basePrayerLevel: 99,
  baseDefenceLevel: 99,
  baseAttackLevel: 99,
  baseStrengthLevel: 99,
};

function meetsPrayerLevel(slot: PrayerSlot, availability: PrayerAvailability): boolean {
  return availability.basePrayerLevel >= slot.level;
}

/** Stat requirements belong to the effective prayer, independently of its Prayer level. */
function meetsPrayerRequirements(slot: PrayerSlot, availability: PrayerAvailability): boolean {
  return (
    availability.baseDefenceLevel >= (slot.defenceLevel ?? 1) &&
    availability.baseAttackLevel >= (slot.attackLevel ?? 1) &&
    availability.baseStrengthLevel >= (slot.strengthLevel ?? 1)
  );
}

/**
 * Whether a prayer is usable at all — level AND requirements together.
 *
 * The tier row consults this for a prayer's SUCCESSOR without consulting either
 * filter row, so a Piety you cannot yet pray for never suppresses Chivalry even
 * with both level and requirement rows left checked.
 */
export function isPrayerAvailable(slot: PrayerSlot, availability: PrayerAvailability): boolean {
  return meetsPrayerLevel(slot, availability) && meetsPrayerRequirements(slot, availability);
}

export interface ResolvedPrayerSlot extends PrayerSlot {
  /**
   * Sprite name to paint, which is the upgrade's once one has taken the slot over. `icon` stays
   * the base name because the hidden set and the reorder order persist under it, so renaming it
   * to the upgrade's unhides a hidden slot and drops it to the end of a customized book.
   */
  displayIcon: string;
  basePrayer: PrayerType | undefined;
  available: boolean;
}

export function resolvePrayerSlots(
  grid: readonly PrayerSlot[],
  availability: PrayerAvailability = UNGATED,
  unlocks: PrayerUnlocks = {},
): ResolvedPrayerSlot[] {
  return grid.map((slot) => {
    const upgrade = slot.upgrade;
    if (
      upgrade === undefined ||
      !isPrayerUnlocked(upgrade.prayer, unlocks) ||
      availability.basePrayerLevel < upgrade.level
    ) {
      return {
        ...slot,
        displayIcon: slot.icon,
        basePrayer: slot.prayer,
        available: isPrayerAvailable(slot, availability),
      };
    }
    const resolved = {
      ...slot,
      ...upgrade,
      icon: slot.icon,
      // An upgrade replaces all requirements; absent stats must not inherit the base prayer's gate.
      defenceLevel: upgrade.defenceLevel,
      attackLevel: upgrade.attackLevel,
      strengthLevel: upgrade.strengthLevel,
      displayIcon: upgrade.icon,
      basePrayer: slot.prayer,
    };
    return { ...resolved, available: isPrayerAvailable(resolved, availability) };
  });
}

/**
 * Derived per call rather than migrated into storage: the saved set still holds the base prayer,
 * so switching the account toggle back off restores what the player chose.
 */
export function resolveQuickPrayerSelections(
  selections: readonly string[],
  availability: PrayerAvailability = UNGATED,
  unlocks: PrayerUnlocks = {},
): string[] {
  const resolvedSlots = resolvePrayerSlots(PRAYER_GRID, availability, unlocks);
  const canonicalPrayers = new Map<string, PrayerType>(
    PRAYER_GRID.flatMap((slot) => {
      if (slot.prayer === undefined) return [];
      return slot.upgrade === undefined
        ? [[slot.prayer, slot.prayer] as const]
        : [[slot.prayer, slot.prayer] as const, [slot.upgrade.prayer, slot.prayer] as const];
    }),
  );
  const replacements = new Map<string, PrayerType>(
    resolvedSlots.flatMap((slot) =>
      slot.basePrayer !== undefined && slot.prayer !== undefined && slot.basePrayer !== slot.prayer
        ? [[slot.basePrayer, slot.prayer] as const]
        : [],
    ),
  );
  const availablePrayers = new Set<string>(
    resolvedSlots.flatMap((slot) => (slot.prayer !== undefined && slot.available ? [slot.prayer] : [])),
  );
  return [
    ...new Set(
      selections.map((prayer) => {
        const canonical = canonicalPrayers.get(prayer) ?? prayer;
        return replacements.get(canonical) ?? canonical;
      }),
    ),
  ].filter((prayer) => availablePrayers.has(prayer));
}

export function sortPrayerGrid(order: string[] | null, grid: PrayerSlot[]): PrayerSlot[] {
  if (!order) return grid;
  const rank = new Map(order.map((icon, index) => [icon, index]));
  return [...grid].sort((a, b) => {
    const aRank = rank.get(a.icon);
    const bRank = rank.get(b.icon);
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
    if (aRank !== undefined) return -1;
    if (bRank !== undefined) return 1;
    return grid.findIndex((s) => s.icon === a.icon) - grid.findIndex((s) => s.icon === b.icon);
  });
}

/**
 * Independent filter conjuncts in panel order. Options use the positive "show" sense defined
 * in src/types/panelFilters.ts.
 */
export function passesPrayerFilter(
  slot: PrayerSlot,
  filterOptions: PrayerFilterOptions,
  availability: PrayerAvailability,
  prayersByIcon: ReadonlyMap<string, PrayerSlot> = PRAYER_BY_ICON,
): boolean {
  const successor = slot.successor === undefined ? undefined : prayersByIcon.get(slot.successor);
  if (
    successor &&
    !filterOptions.showLowerTiers &&
    (!filterOptions.showTieredOverMultiskill || successor.tierGroup === slot.tierGroup) &&
    isPrayerAvailable(successor, availability)
  ) {
    return false;
  }

  if (!filterOptions.showRapidHealing && slot.healing) return false;
  if (!filterOptions.showLackLevel && !meetsPrayerLevel(slot, availability)) return false;
  if (!filterOptions.showLackRequirements && !meetsPrayerRequirements(slot, availability)) return false;

  return true;
}

export function filterPrayerGrid<T extends PrayerSlot>(
  sortedGrid: T[],
  hiddenSet: Set<string>,
  filterOptions: PrayerFilterOptions,
  filteringEnabled: boolean,
  reorderMode: boolean,
  availability: PrayerAvailability = UNGATED,
): T[] {
  if (reorderMode) return sortedGrid;

  const filtered = sortedGrid.filter((slot) => !hiddenSet.has(slot.icon));
  if (!filteringEnabled) return filtered;
  const prayersByIcon = new Map(sortedGrid.map((slot) => [slot.icon, slot]));
  return filtered.filter((slot) => passesPrayerFilter(slot, filterOptions, availability, prayersByIcon));
}
