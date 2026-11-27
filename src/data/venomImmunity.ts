/**
 * Head pieces that make the player immune to venom and poison while worn: the charged serpentine helm
 * and its cosmetic tanzanite and magma recolours, which "do not apply any stat changes"
 * (https://oldschool.runescape.wiki/w/Serpentine_helm). The uncharged helm (12929) cannot be worn.
 */
export const VENOM_IMMUNE_HEAD_IDS: ReadonlySet<number> = new Set([
  12931, // Serpentine helm
  13197, // Tanzanite helm
  13199, // Magma helm
]);
