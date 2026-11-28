/**
 * Item ids the infobox row paints directly, rather than reading off a loadout.
 *
 * These are the one class of item sprite no picker or preset can reach, so they are
 * invisible to the catalogs {@link collectItemIconIds} unions. They live here, in data,
 * so both `selectInfoboxes` and the icon-mirror derivation read the same constant;
 * declaring one inline in the component leaves its icon unmirrored.
 */
export const INFOBOX_ITEM_IDS = {
  /** Matches RuneLite's GameTimer.SATURATED_HEART icon. */
  saturatedHeart: 27641,
  /** Antipoison(4) — matches RuneLite's GameTimer.ANTIPOISON icon. */
  antipoison: 2446,
  /** Surge potion(4), the full dose, for the surge potion cooldown. */
  surgePotion: 30875,
  /** Overload (+)(4) — matches RuneLite's GameTimer.OVERLOAD icon in CoX. */
  overloadPlus: 20996,
} as const;
