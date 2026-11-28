import type { CombatSupplies } from '../types/encounterLoadout';
import { ARDER_MUSCA_POISON_ITEM_ID, createEmptyInventory, parseInventoryFromSetup } from '../types/inventory';
import type { EncounterPreset } from '../types/player';
import { HALIBUT_ITEM_ID } from './itemIds';
import { computeSetRequirements } from './itemRequirements';
import { COMBINATION_RUNE, RUNE } from './spellRunes';

/**
 * Shared No-Equipment fallback set. Marked {@link EncounterPreset.isFallback} so the
 * loadout picker never offers it as a selectable row when a group has real equipment
 * sets: it is auto-applied only when every real set is blocked by the configured stats,
 * and the loadout auto-recovers to the first compatible real set once stats allow.
 */
const NO_EQUIPMENT_FALLBACK: EncounterPreset = {
  name: 'No Equipment',
  equipment: {},
  inventory: createEmptyInventory(),
  isFallback: true,
};

/**
 * Divine rune pouch contents (item 27281) shared by the Yama sets and the Sol Heredit sets that
 * carry one; both are fought on the Arceuus book.
 *
 * The three Arceuus spells a trip actually
 * needs are Death Charge (1 blood, 1 death, 1 soul), Dark Demonbane (7 fire, 2 soul)
 * and a greater thrall (10 fire, 5 blood, 1 cosmic). Aether runes count as one cosmic
 * AND one soul rune each, which is what collapses those requirements to four distinct
 * runes — exactly the number of slots a divine rune pouch has
 * (https://oldschool.runescape.wiki/w/Aether_rune).
 */
const ARCEUUS_DIVINE_RUNE_POUCH = {
  kind: 'divine',
  slots: [{ id: RUNE.death }, { id: RUNE.fire }, { id: RUNE.blood }, { id: COMBINATION_RUNE.aether }],
} as const satisfies CombatSupplies['runePouch'];

/**
 * Supplies for the Yama sets. Every set, melee ones included, casts from the Arceuus pouch, and
 * none but Sensory Clouding's carries ammo or a blowpipe. No spell is preselected: the player
 * picks their own autocast.
 */
const YAMA_SUPPLIES: CombatSupplies = {
  equippedAmmo: null,
  quiverAmmo: null,
  runePouch: ARCEUUS_DIVINE_RUNE_POUCH,
  blowpipe: null,
  selectedSpell: null,
  spellbook: 'arceuus',
};

/**
 * Sensory Clouding is the one Yama set that carries a bow (the scorching bow switch, for its
 * demon-binding special), and a bow with an empty ammo slot resolves to `unavailable` and simply
 * never fires. Dragon arrows are the best the bow accepts; they are `ALLOWED` rather than
 * `INCLUDED` alongside the equipped staff, so they change nothing about the magic setup.
 */
const YAMA_SENSORY_SUPPLIES: CombatSupplies = {
  ...YAMA_SUPPLIES,
  equippedAmmo: { id: 11212 },
};

/**
 * Slots 7-27 of the Max Tbow and Bowfa sets: 2 Bastion potion(4), 2 Prayer regeneration
 * potion(4), 1 Stamina potion(4), then 8 Saradomin brew(4) in columns 1-2 and 8 Super restore(4)
 * in columns 3-4. The five boosts leave row 3 one short, so the first restore starts its
 * columns at slot 12.
 *
 * The wiki lists a third prayer regeneration potion, but its inventory images equip the MAGE
 * setup and carry only the ranged pieces as switches. These sets equip the RANGED gear, so the
 * one-handed weapon and shield are carried instead, costing a slot.
 * https://oldschool.runescape.wiki/w/Inferno/Strategies#Inventory_Setups (retrieved 2026-07-29)
 */
const INFERNO_WIKI_SUPPLIES = [
  { id: 22461 }, // Bastion potion(4)
  { id: 22461 }, // Bastion potion(4)
  { id: 30125 }, // Prayer regeneration potion(4)
  { id: 30125 }, // Prayer regeneration potion(4)
  { id: 12625 }, // Stamina potion(4)
  { id: 3024 }, // Super restore(4)
  { id: 6685 }, // Saradomin brew(4)
  { id: 6685 }, // Saradomin brew(4)
  { id: 3024 }, // Super restore(4)
  { id: 3024 }, // Super restore(4)
  { id: 6685 }, // Saradomin brew(4)
  { id: 6685 }, // Saradomin brew(4)
  { id: 3024 }, // Super restore(4)
  { id: 3024 }, // Super restore(4)
  { id: 6685 }, // Saradomin brew(4)
  { id: 6685 }, // Saradomin brew(4)
  { id: 3024 }, // Super restore(4)
  { id: 3024 }, // Super restore(4)
  { id: 6685 }, // Saradomin brew(4)
  { id: 6685 }, // Saradomin brew(4)
  { id: 3024 }, // Super restore(4)
];

/**
 * Divine rune pouch contents shared by the two wiki Inferno setups (item 27281): Ice
 * Barrage (6 water, 2 blood, 4 death) plus Blood Barrage (4 blood, 4 death, 1 soul) need
 * four distinct runes, which is exactly what a divine pouch holds.
 * https://oldschool.runescape.wiki/w/Inferno/Strategies#Inventory_Setups (retrieved 2026-07-29)
 */
const INFERNO_DIVINE_RUNE_POUCH = {
  kind: 'divine',
  slots: [{ id: RUNE.soul }, { id: RUNE.blood }, { id: RUNE.death }, { id: RUNE.water }],
} as const satisfies CombatSupplies['runePouch'];

/**
 * Three-slot Rune pouch for the lowest sets, which autocast Ice Burst (70 Magic) rather
 * than Ice Barrage (94 Magic). Ice Burst costs 4 water, 4 chaos and 2 death, so all three
 * rune types fit and no loose stack is needed.
 * https://oldschool.runescape.wiki/w/Ice_Burst (retrieved 2026-07-29)
 */
const INFERNO_BURST_RUNE_POUCH = {
  kind: 'standard',
  slots: [{ id: RUNE.water }, { id: RUNE.chaos }, { id: RUNE.death }],
} as const satisfies CombatSupplies['runePouch'];

/**
 * Supplies shared by the community 2025 Inferno sets. The ammo slot holds Rada's blessing 4, and the quiver
 * of the worn Dizana's max cape holds the arrows. The screenshots show 114k Dragon arrows; Seeking
 * dragon arrows are the user's choice. The darts in the Blazing blowpipe cannot be seen, so Dragon
 * darts are assumed.
 */
const SPEEDRUN_2025_SUPPLIES = {
  equippedAmmo: { id: 22947 }, // Rada's blessing 4
  quiverAmmo: { id: 33595 }, // Seeking dragon arrow (preset policy; shown: Dragon arrow)
  blowpipe: { id: 11230 }, // Dragon dart (assumed; not visible)
} as const satisfies Partial<CombatSupplies>;

/**
 * Preset policy: Water replaces the screenshot's fourth rune (Air) so that Ice Barrage (water,
 * death, blood) and Blood Barrage (death, blood, soul) can both be cast without the Kodai worn.
 */
const SPEEDRUN_ANCIENTS_RUNE_POUCH = {
  kind: 'divine',
  slots: [{ id: RUNE.death }, { id: RUNE.blood }, { id: RUNE.soul }, { id: RUNE.water }],
} as const satisfies CombatSupplies['runePouch'];

/**
 * The Zuk sets follow docs/design/loadout-presets.md. Two constraints shape them, both checked by
 * src/data/__tests__/zukPlayerPresets.test.ts:
 *
 * 1. SWAP HEADROOM. Equipping a two-handed weapon from a one-handed weapon and shield unequips
 *    BOTH into the inventory, a net +1 item. The crossbow sets carry two-handers (the atlatl and
 *    the toxic blowpipe), so each keeps exactly one slot free, at the next zig-zag stop after its
 *    switches, where the Crystal shield drops. Sets that start on a two-hander run a full 28.
 *
 * 2. AMMO SLOTS. Dizana's quiver is a second ammo slot, so a set wearing one can hold two ammo
 *    types at once (worn + stored). A set on Ava's assembler has ONE ammo slot, so its second
 *    ammo type is carried as an inventory stack and swapped by hand.
 */
const INFERNO_PRESETS: Record<string, EncounterPreset> = {
  // Inferno sets below follow the OSRS Wiki Inferno strategy page, retrieved 2026-07-29:
  // https://oldschool.runescape.wiki/w/Inferno/Strategies
  //
  // One wiki pick has no entry in the bundled DPS item dataset, so the closest modeled
  // equivalent stands in: Blessed d'hide boots -> Ancient d'hide boots, which is the very
  // icon the wiki uses for them (they are the same god-dragonhide item in every stat).
  //
  // The ranged presets invert the wiki's mage-start inventories, carrying magic gear as
  // switches. Mage Tank starts with Shadow and Ancestral, carrying tank gear as switches.
  // Every ranged set puts its magic switch top-left, the switch it reaches for at each healer
  // spawn, in zig-zag click order (slots 1, 5, 2, 6, 3, ...): weapon first, then the pieces that
  // add the most magic damage and accuracy, with the defensive shield last.
  max_tbow: {
    // Wiki #Inventory_Setups, Max Twisted bow inventory.
    name: 'Max Tbow',
    equipment: {
      head: 25912, // TzKal slayer helmet (i) — receives its Inferno task bonus automatically
      cape: 28951, // Dizana's quiver (charged)
      amulet: 33639, // Necklace of rupture
      weapon: 20997, // Twisted bow (two-handed, so no shield)
      body: 27238, // Masori body (f)
      legs: 27241, // Masori chaps (f)
      hands: 26235, // Zaryte vambraces
      boots: 31097, // Avernic treads (max)
      ring: 28310,
    },
    inventory: parseInventoryFromSetup([
      { id: 21006 }, // Kodai wand
      { id: 26243 }, // Virtus robe top
      { id: 12817 }, // Elysian spirit shield
      { id: 12926 }, // Toxic blowpipe (loaded; off-weapon, outside the zig-zag)
      { id: 31106 }, // Confliction gauntlets
      { id: 26245 }, // Virtus robe bottom
      ...INFERNO_WIKI_SUPPLIES,
      { id: 27281 }, // Divine rune pouch
    ]),
    supplies: {
      equippedAmmo: { id: 22947 }, // Rada's blessing 4
      quiverAmmo: { id: 33595 },
      runePouch: INFERNO_DIVINE_RUNE_POUCH,
      blowpipe: { id: 11230 }, // Dragon dart
      selectedSpell: 'Ice Barrage',
      spellbook: 'ancient',
    },
  },
  bowfa: {
    // Wiki #Inventory_Setups, Bow of faerdhinen inventory.
    name: 'Bowfa',
    equipment: {
      head: 23971, // Crystal helm
      cape: 22109, // Ava's assembler
      amulet: 19547, // Necklace of anguish
      weapon: 25865, // Bow of faerdhinen (two-handed, so no shield)
      body: 23975, // Crystal body
      legs: 23979, // Crystal legs
      hands: 7462, // Barrows gloves
      boots: 22954, // Devout boots
      ring: 26764,
    },
    inventory: parseInventoryFromSetup([
      { id: 27624 }, // Ancient sceptre
      { id: 4712 }, // Ahrim's robetop
      { id: 23991 }, // Crystal shield
      { id: 12926 }, // Toxic blowpipe (loaded; off-weapon, outside the zig-zag)
      { id: 12002 }, // Occult necklace
      { id: 4714 }, // Ahrim's robeskirt
      ...INFERNO_WIKI_SUPPLIES,
      { id: 27281 }, // Divine rune pouch
    ]),
    supplies: {
      // Ava's assembler is not a quiver, but nothing here needs a second ammo type: the Bow
      // of faerdhinen consumes no ammo and the blowpipe carries its own darts.
      equippedAmmo: { id: 22947 }, // Rada's blessing 4
      quiverAmmo: null,
      runePouch: INFERNO_DIVINE_RUNE_POUCH,
      blowpipe: { id: 25849 }, // Amethyst dart
      selectedSpell: 'Ice Barrage',
      spellbook: 'ancient',
    },
  },
  atlatl_eclipse: {
    // The wiki has no Inferno atlatl loadout, so this is built from the Eclipse atlatl's own
    // recommended-equipment guidance (https://oldschool.runescape.wiki/w/Eclipse_atlatl):
    //  - Max hit scales off MELEE Strength while accuracy stays Ranged, so best-in-slot ranged
    //    gear is not best here. Against high-Defence targets the page names Amulet of fury,
    //    Barrows gloves and Aranea boots as beating specialized ranged pieces — the Inferno case.
    //  - The full eclipse moon set is worn rather than split, because the set effect (20% chance
    //    of a stacking burn on an atlatl hit) needs all three pieces.
    //  - Ava's assembler, not Dizana's quiver: atlatl darts cannot be stored in the quiver, and
    //    only Ava's devices retrieve them (https://oldschool.runescape.wiki/w/Atlatl_dart).
    // Opens on the one-handed rune crossbow so the Crystal shield is up; the two-handed atlatl
    // and its darts are the paired weapon+ammo swap. The atlatl's special attack is not
    // simulated (its one verification gap); the set never relies on it.
    //
    // The inventory follows the wiki Bowfa inventory: the same magic switch, blowpipe and
    // supplies, with a Super combat potion in place of one Bastion potion, and one brew and one
    // restore dropped for the atlatl, its darts and the free slot.
    name: 'Atlatl / RCB (Eclipse)',
    equipment: {
      head: 29035, // Eclipse moon helm
      cape: 22109, // Ava's assembler
      amulet: 6585, // Amulet of fury
      weapon: 9185, // Rune crossbow
      body: 29031, // Eclipse moon chestplate
      shield: 23991, // Crystal shield
      legs: 29033, // Eclipse moon tassets
      hands: 7462, // Barrows gloves
      boots: 29806, // Aranea boots
      ring: 26764, // Ring of the gods (i)
    },
    inventory: parseInventoryFromSetup([
      // Rows 1-2: the magic switch (slots 1, 5, 2, 6), then the atlatl and its darts (3, 7). Slot 4,
      // the next zig-zag stop, is the one free slot: the Crystal shield drops there when the atlatl
      // or the blowpipe is wielded, so swapping back ends on it.
      { id: 6914 }, // Master wand
      { id: 4712 }, // Ahrim's robetop
      { id: 29000 }, // Eclipse atlatl (two-handed)
      null, // Free: the Crystal shield lands here when a two-hander is wielded
      { id: 12002 }, // Occult necklace
      { id: 4714 }, // Ahrim's robeskirt
      { id: 28991 }, // Atlatl dart — paired ammo swap, no quiver worn
      { id: 12926 }, // Toxic blowpipe (loaded, two-handed; off-weapon, outside the zig-zag)
      // Super combat, NOT a plain Strength potion: this set's max hit scales off melee
      // Strength (see the header), and Super combat is the only Strength boost itemEffects
      // implements — a Strength/Super strength id would sit in the inventory doing nothing.
      { id: 12695 }, // Super combat potion(4)
      { id: 22461 }, // Bastion potion(4)
      { id: 30125 }, // Prayer regeneration potion(4)
      { id: 30125 }, // Prayer regeneration potion(4)
      { id: 12625 }, // Stamina potion(4)
      // Brews in columns 1-2, restores in columns 3-4; the last brew and restore share row 7.
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 12791 }, // Rune pouch (bottom-right utility slot)
    ]),
    supplies: {
      // One ammo slot only. The crossbow's bolts are worn because the set opens on it; the
      // atlatl's darts ride in the inventory and are equipped alongside the atlatl.
      equippedAmmo: { id: 9242 }, // Ruby bolts (e)
      quiverAmmo: null,
      runePouch: INFERNO_BURST_RUNE_POUCH,
      blowpipe: { id: 25849 }, // Amethyst dart
      selectedSpell: 'Ice Burst',
      spellbook: 'ancient',
    },
  },
  budget_rcb: {
    // Bottom column of the wiki's First cape table (blessed dragonhide + Bloodbark, Master
    // wand, Crystal shield, Barrows gloves) with the crossbow dropped from Dragon to Rune.
    // A Rune crossbow tops out at RUNITE bolts, so this set fires Ruby/Diamond bolts (e) and
    // NOT the ruby/diamond dragon bolts (e) the wiki lists for the dragon-bolt crossbows
    // (https://oldschool.runescape.wiki/w/Rune_crossbow).
    //
    // Ava's assembler replaces the wiki's cape3/cape4 (Max cape, Ranging cape (t)) because both
    // of those want 99s while the assembler wants 70 Ranged and retrieves ammo. Ice Burst
    // replaces Ice Barrage: 70 Magic instead of 94 fits the rest of this set.
    //
    // That table has no inventory, so this follows the wiki Bowfa inventory: the same magic
    // switch slots, blowpipe and supplies, plus the Diamond bolts (e) swap, with one Bastion
    // potion dropped for the free slot.
    name: 'Budget (Rune xbow)',
    equipment: {
      head: 4753, // Verac's helm
      cape: 22109, // Ava's assembler
      amulet: 6585, // Amulet of fury
      weapon: 9185, // Rune crossbow
      body: 12492, // Ancient d'hide body (wiki: Blessed dragonhide body)
      shield: 23991, // Crystal shield
      legs: 12494, // Ancient chaps (wiki: Blessed dragonhide chaps)
      hands: 7462, // Barrows gloves
      boots: 19921, // Ancient d'hide boots (wiki: Blessed d'hide boots)
      ring: 26764, // Ring of the gods (i)
    },
    inventory: parseInventoryFromSetup([
      // Rows 1-2: the magic switch (slots 1, 5, 2, 6). Slot 3, the next zig-zag stop, is the one
      // free slot: the Crystal shield drops there when the two-handed blowpipe is wielded. The
      // blowpipe and the bolt swap sit in column 4.
      { id: 6914 }, // Master wand
      { id: 25404 }, // Bloodbark body
      null, // Free: the Crystal shield lands here when the blowpipe is wielded
      { id: 12926 }, // Toxic blowpipe (loaded, two-handed; off-weapon, outside the zig-zag)
      { id: 12002 }, // Occult necklace
      { id: 25416 }, // Bloodbark legs
      { id: 22461 }, // Bastion potion(4)
      { id: 9243 }, // Diamond bolts (e) — manual ammo swap, no quiver worn
      { id: 30125 }, // Prayer regeneration potion(4)
      { id: 30125 }, // Prayer regeneration potion(4)
      { id: 12625 }, // Stamina potion(4)
      // Brews in columns 1-2, restores in columns 3-4; the first restore starts at slot 12.
      { id: 3024 }, // Super restore(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 12791 }, // Rune pouch (bottom-right utility slot)
    ]),
    supplies: {
      equippedAmmo: { id: 9242 }, // Ruby bolts (e)
      quiverAmmo: null,
      runePouch: INFERNO_BURST_RUNE_POUCH,
      blowpipe: { id: 25849 }, // Amethyst dart
      selectedSpell: 'Ice Burst',
      spellbook: 'ancient',
    },
  },
  mage_tank: {
    // Wiki Mage tank inventory: https://oldschool.runescape.wiki/w/Inferno/Strategies#Inventory_Setups
    // Retrieved 2026-11-07. Starts in Shadow/Ancestral with the tank gear as switches, so the ward
    // the wiki wears is carried, and one of the wiki's "2-3" Prayer regeneration potions makes room.
    // The Eldritch Nightmare staff autocasts the barrages; its Invocate special is not simulated.
    name: 'Mage Tank',
    equipment: {
      head: 21018, // Ancestral hat
      cape: 21791, // Imbued saradomin cape
      amulet: 12002, // Occult necklace
      weapon: 27275, // Tumeken's shadow (charged, two-handed)
      body: 21021, // Ancestral robe top
      legs: 21024, // Ancestral robe bottom
      hands: 31106, // Confliction gauntlets
      boots: 31097, // Avernic treads (max)
      ring: 28313, // Magus ring
    },
    inventory: parseInventoryFromSetup([
      // Rows 1-2: the tank switch in zig-zag order (slots 1, 5, 2, 6, 3): weapon first, then the
      // biggest defensive gain, with the ward last. Swapping back, re-wielding the two-handed
      // Shadow drops the ward into its old slot 3, the last stop, so the return clicks end before
      // it; with the ward mid-cluster, the return would re-equip it and take the Shadow off.
      // The worn Shadow drops no off-hand on loading, so no slot is kept free.
      { id: 31113 }, // Eye of Ayak (charged)
      { id: 4759 }, // Verac's plateskirt
      { id: 27251 }, // Elidinis' ward (f)
      { id: 24425 }, // Eldritch Nightmare staff (one-handed barrage autocast; off-weapon, outside the zig-zag)
      { id: 11832 }, // Bandos chestplate
      { id: 22326 }, // Justiciar faceguard
      // Supplies: ten restores need columns 3-4 from row 2; the boosts take columns 1-2 above
      // the brews.
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 31638 }, // Extended stamina potion(4)
      { id: 30125 }, // Prayer regeneration potion(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 30125 }, // Prayer regeneration potion(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 27641 }, // Saturated heart (utility, before the pouch)
      { id: 27281 }, // Divine rune pouch (bottom-right utility slot)
    ]),
    supplies: {
      equippedAmmo: { id: 22947 }, // Rada's blessing 4
      quiverAmmo: null,
      runePouch: INFERNO_DIVINE_RUNE_POUCH,
      blowpipe: null,
      selectedSpell: 'Ice Barrage', // Eldritch Nightmare staff autocast; Shadow and Ayak use their own spells
      spellbook: 'ancient',
    },
  },
  // Community replicas. Each set below copies one community player's Inferno screenshots slot for slot:
  // the worn gear, the 28 inventory slots in the screenshot's row-major order, and the rune
  // pouch. They are therefore exempt from the house layout rules in
  // docs/design/loadout-presets.md. Every worn item was checked against the screenshot's
  // "Equip Your Character" totals. The 2025 sets matched every bonus exactly on the simulator's
  // stats; the 2023 set differs only where items have been rebalanced since (noted per set).
  //
  // Preset policy choices that deviate from the screenshots, marked "preset policy" where they appear:
  //  - Extended stamina potion(4) replaces Stamina potion(4) in all four sets.
  //  - Seeking dragon arrows replace Dragon arrows (2025 quiver, First cape: Tbow ammo slot).
  //  - Avernic treads (max) replace the Echo and Aranea boots in the 2025 sets, so their bonuses
  //    differ from the screenshot totals.
  //  - The 2025 Ancients pouches hold Water in place of Air (see SPEEDRUN_ANCIENTS_RUNE_POUCH).
  //  - S65 carries an Elysian spirit shield for its Kodai switch in place of the chinchompas.
  //
  // Substitutions shared by these sets, each made because the shown item is (or was) not modeled:
  //  - The Twisted bow is worn in place of the Black chinchompa, which was unmodeled when these
  //    sets were built; the chinchompas are simulated now, and the layout is kept. They take the
  //    bow's inventory slot (S45; S65 carries an Elysian spirit shield there instead). The Twisted
  //    buckler worn beside them cannot stay on with the two-handed bow, and the inventory is
  //    full, so it is left out.
  //  - Sanguine scythe of vitur -> Scythe of Vitur (the sanguine recolor's swing sound is
  //    unverified). Dragon claws (cr) -> Dragon claws.
  //  - Divine bastion potion(4) and Ranging potion(4) are absent from the simulator catalog,
  //    so both become Bastion potion(4).
  //  - Tzkal slayer helmet (i) and Ring of the gods (i): the screenshots cannot tell the
  //    imbue variants apart, so the ids the wiki sets above use are kept.
  //
  // Read from the 2025 screenshots: the pink potions are Sanfew serum(4) (their salmon color
  // fits Sanfew, not the magenta Super restore). The potion under a magenta RuneLite tag is read
  // as Prayer regeneration potion(4) (best color fit). The tan potion is a plain Stamina
  // potion(4), swapped for Extended stamina as preset policy.
  s65_ancients: {
    // Source: community speedrun setup, 2025-04-09, "Setup 1 (s65 Ancients)", https://i.imgur.com/bHjuk8A.png.
    name: 'S65 Ancients',
    section: 'Speedrun',
    equipment: {
      head: 25912, // Tzkal slayer helmet (i)
      cape: 28902, // Dizana's max cape (its quiver holds the arrows)
      amulet: 22249, // Necklace of anguish (or)
      weapon: 20997, // Twisted bow — stands in for the worn Black chinchompa (see the group note)
      body: 27238, // Masori body (f)
      legs: 27241, // Masori chaps (f)
      hands: 26235, // Zaryte vambraces
      boots: 31097, // Avernic treads (max) (preset policy; shown: Echo boots)
      ring: 26764, // Ring of the gods (i)
    },
    inventory: parseInventoryFromSetup([
      { id: 21006 }, // Kodai wand
      { id: 10925 }, // Sanfew serum(4)
      { id: 10925 }, // Sanfew serum(4)
      { id: 27281 }, // Divine rune pouch
      { id: 30439 }, // Echo virtus robe top
      { id: 28688 }, // Blazing blowpipe
      // Preset policy: the Kodai switch's shield takes the Tbow's slot. The screenshot's buckler
      // drops with the two-handed bow, and the chinchompas are left out of this set.
      { id: 12817 }, // Elysian spirit shield
      { id: 10925 }, // Sanfew serum(4)
      { id: 22325 }, // Scythe of Vitur (shown: Sanguine scythe of vitur)
      { id: 10925 }, // Sanfew serum(4)
      { id: 10925 }, // Sanfew serum(4)
      { id: 10925 }, // Sanfew serum(4)
      { id: 22981 }, // Ferocious gloves
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 10925 }, // Sanfew serum(4)
      { id: 12695 }, // Super combat potion(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 22461 }, // Bastion potion(4) (shown: Ranging potion(4))
      { id: 22461 }, // Bastion potion(4) (shown: Divine bastion potion(4))
      { id: 22461 }, // Bastion potion(4) (shown: Divine bastion potion(4))
      { id: 22461 }, // Bastion potion(4) (shown: Divine bastion potion(4))
      { id: 10925 }, // Sanfew serum(4)
      { id: 31638 }, // Extended stamina potion(4) (preset policy; shown: Stamina potion(4))
      { id: 30125 }, // Prayer regeneration potion(4) (tagged; see the group note)
      { id: 10925 }, // Sanfew serum(4)
      { id: 10925 }, // Sanfew serum(4)
    ]),
    supplies: {
      ...SPEEDRUN_2025_SUPPLIES,
      runePouch: SPEEDRUN_ANCIENTS_RUNE_POUCH,
      selectedSpell: 'Ice Barrage', // Kodai switch; the wand supplies the water runes
      spellbook: 'ancient',
    },
  },
  s50_ancients: {
    // Source: community speedrun setup, 2025-04-09, "Setup 2 (s50 Ancients)", https://i.imgur.com/xy4aFqB.png. Worn as shown:
    // the Kodai and the Twisted buckler, with the 3.0s weapon speed of an autocast barrage.
    name: 'S50 Ancients',
    section: 'Speedrun',
    equipment: {
      head: 25912, // Tzkal slayer helmet (i)
      cape: 28902, // Dizana's max cape (its quiver holds the arrows)
      amulet: 22249, // Necklace of anguish (or)
      weapon: 21006, // Kodai wand
      body: 27238, // Masori body (f)
      shield: 21000, // Twisted buckler
      legs: 27241, // Masori chaps (f)
      hands: 26235, // Zaryte vambraces
      boots: 31097, // Avernic treads (max) (preset policy; shown: Aranea boots)
      ring: 26764, // Ring of the gods (i)
    },
    inventory: parseInventoryFromSetup([
      { id: 10925 }, // Sanfew serum(4)
      { id: 10925 }, // Sanfew serum(4)
      { id: 10925 }, // Sanfew serum(4)
      { id: 27281 }, // Divine rune pouch
      { id: 28688 }, // Blazing blowpipe
      { id: 20997 }, // Twisted bow
      { id: 11959 }, // Black chinchompa
      { id: 10925 }, // Sanfew serum(4)
      { id: 22325 }, // Scythe of Vitur (shown: Sanguine scythe of vitur)
      { id: 22981 }, // Ferocious gloves
      { id: 10925 }, // Sanfew serum(4)
      { id: 10925 }, // Sanfew serum(4)
      { id: 24780 }, // Amulet of blood fury
      { id: 21285 }, // Infernal max cape
      { id: 6685 }, // Saradomin brew(4)
      { id: 22461 }, // Bastion potion(4) (shown: Ranging potion(4))
      { id: 12695 }, // Super combat potion(4)
      { id: 12695 }, // Super combat potion(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 22461 }, // Bastion potion(4) (shown: Divine bastion potion(4))
      { id: 22461 }, // Bastion potion(4) (shown: Divine bastion potion(4))
      { id: 22461 }, // Bastion potion(4) (shown: Divine bastion potion(4))
      { id: 10925 }, // Sanfew serum(4)
      { id: 31638 }, // Extended stamina potion(4) (preset policy; shown: Stamina potion(4))
      { id: 30125 }, // Prayer regeneration potion(4) (tagged; see the group note)
      { id: 10925 }, // Sanfew serum(4)
      { id: 10925 }, // Sanfew serum(4)
    ]),
    supplies: {
      ...SPEEDRUN_2025_SUPPLIES,
      runePouch: SPEEDRUN_ANCIENTS_RUNE_POUCH,
      selectedSpell: 'Ice Barrage',
      spellbook: 'ancient',
    },
  },
  s45_arceuus: {
    // Source: community speedrun setup, 2025-04-09, "Setup 3 (s45 Arceuus)", https://i.imgur.com/jphWR61.png. No magic weapon:
    // thralls come from the Book of the Dead, and the 934k loose Soul runes cover Death Charge
    // and Mark of Darkness with the pouch's blood, death and cosmic. Nothing is autocast, so no
    // spell is preselected. The thrall spells themselves are not simulated.
    name: 'S45 Arceuus',
    section: 'Speedrun',
    equipment: {
      head: 25912, // Tzkal slayer helmet (i)
      cape: 28902, // Dizana's max cape (its quiver holds the arrows)
      amulet: 22249, // Necklace of anguish (or)
      weapon: 20997, // Twisted bow — stands in for the worn Black chinchompa (see the group note)
      body: 27238, // Masori body (f)
      legs: 27241, // Masori chaps (f)
      hands: 26235, // Zaryte vambraces
      boots: 31097, // Avernic treads (max) (preset policy; shown: Aranea boots)
      ring: 28310, // Venator ring
    },
    inventory: parseInventoryFromSetup([
      { id: 10925 }, // Sanfew serum(4)
      { id: 10925 }, // Sanfew serum(4)
      { id: 10925 }, // Sanfew serum(4)
      { id: 27281 }, // Divine rune pouch
      { id: 28688 }, // Blazing blowpipe
      { id: 11959 }, // Black chinchompa — the worn weapon in the screenshot (Tbow's slot)
      { id: 25818 }, // Book of the dead
      { id: RUNE.soul }, // Soul rune
      { id: 22325 }, // Scythe of Vitur (shown: Sanguine scythe of vitur)
      { id: 24780 }, // Amulet of blood fury
      { id: 28256 }, // Sanguine torva platebody
      { id: 10925 }, // Sanfew serum(4)
      { id: 13652 }, // Dragon claws (shown: Dragon claws (cr))
      { id: 22981 }, // Ferocious gloves
      { id: 28258 }, // Sanguine torva platelegs
      { id: 10925 }, // Sanfew serum(4)
      { id: 23685 }, // Divine super combat potion(4)
      { id: 23685 }, // Divine super combat potion(4)
      { id: 10925 }, // Sanfew serum(4)
      { id: 10925 }, // Sanfew serum(4)
      { id: 22461 }, // Bastion potion(4) (shown: Divine bastion potion(4))
      { id: 22461 }, // Bastion potion(4) (shown: Divine bastion potion(4))
      { id: 10925 }, // Sanfew serum(4)
      { id: 10925 }, // Sanfew serum(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 31638 }, // Extended stamina potion(4) (preset policy; shown: Stamina potion(4))
      { id: 30125 }, // Prayer regeneration potion(4) (tagged; see the group note)
    ]),
    supplies: {
      ...SPEEDRUN_2025_SUPPLIES,
      runePouch: {
        kind: 'divine',
        // Smoke chosen over Dust and Mud from the gray cloud glyph.
        slots: [{ id: RUNE.blood }, { id: RUNE.death }, { id: COMBINATION_RUNE.smoke }, { id: RUNE.cosmic }],
      },
      selectedSpell: null,
      spellbook: 'arceuus',
    },
  },
  // The 2023 set comes from a community first-cape guide and is worn as shown, starting on the
  // Kodai. Its pouch holds Ice Barrage and Blood Barrage runes, which puts it on Ancients.
  // Its 2023 panel shows more Magic damage than these items give now: Occult necklace was
  // 10% then and is 5% now.
  first_cape_tbow: {
    // Source: community first-cape guide, 2023-06-15, "Tbow setup", https://imgur.com/fxhos5k. Every
    // bonus matches except Magic damage: 25% then, 20% now. The panel's +72 ranged strength
    // counted the screenshot's Dragon arrows even with the Kodai worn, as the 2023 panel did.
    name: 'First cape: Tbow',
    section: 'Speedrun',
    equipment: {
      head: 27235, // Masori mask (f)
      cape: 27363, // Masori assembler max cape
      amulet: 19720, // Occult necklace (or)
      weapon: 21006, // Kodai wand
      body: 27238, // Masori body (f)
      shield: 12817, // Elysian spirit shield
      legs: 27241, // Masori chaps (f)
      hands: 26235, // Zaryte vambraces
      boots: 22954, // Devout boots
      ring: 26764, // Ring of the gods (i)
    },
    inventory: parseInventoryFromSetup([
      { id: 12926 }, // Toxic blowpipe
      { id: 24666 }, // Twisted ancestral robe top
      { id: 20997 }, // Twisted bow
      { id: 27281 }, // Divine rune pouch
      { id: 22249 }, // Necklace of anguish (or)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 22461 }, // Bastion potion(4)
      { id: 6685 }, // Saradomin brew(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
      { id: 31638 }, // Extended stamina potion(4) (preset policy; shown: Stamina potion(4))
      { id: 22461 }, // Bastion potion(4)
      { id: 3024 }, // Super restore(4)
      { id: 3024 }, // Super restore(4)
    ]),
    supplies: {
      equippedAmmo: { id: 33595 }, // Seeking dragon arrow (preset policy; shown: 131k Dragon arrows)
      quiverAmmo: null,
      runePouch: {
        kind: 'divine',
        slots: [{ id: RUNE.death }, { id: RUNE.water }, { id: RUNE.blood }, { id: RUNE.soul }],
      },
      blowpipe: { id: 11230 }, // Dragon dart (assumed; not visible)
      selectedSpell: 'Ice Barrage',
      spellbook: 'ancient',
    },
  },
  naked: NO_EQUIPMENT_FALLBACK,
};

export const EQUIPMENT_PRESETS: Record<string, Record<string, EncounterPreset>> = {
  lobby: {
    naked: NO_EQUIPMENT_FALLBACK,
  },
  zuk: INFERNO_PRESETS,
  inferno: INFERNO_PRESETS,
  sol_heredit: {
    max: {
      // OSRS Wiki: /w/Fortis_Colosseum/Strategies#Ranged inventory and hands1 row, plus
      // #Melee_only weapon1/special2 rows. The committed melee gear stays worn; ranged gear is
      // moved here as inventory switches.
      name: 'Max (Scythe)',
      equipment: {
        head: 28254, // Sanguine torva full helm (recolor of Torva full helm)
        cape: 21295, // Infernal cape
        amulet: 29804, // Amulet of rancour (s)
        weapon: 22325, // Scythe of Vitur
        body: 30779, // Radiant oathplate chest (recolor of Oathplate chest)
        legs: 30781, // Radiant oathplate legs (recolor of Oathplate legs)
        hands: 22981, // Ferocious gloves
        boots: 31097, // Avernic treads (max)
        ring: 28307, // Ultor ring
      },
      inventory: parseInventoryFromSetup([
        // Rows 1-2: the ranged switch in zig-zag click order (slot 1, 5, 2, 6, 3, 7): bow first, then the
        // biggest-gain pieces. Column 4 holds the off-style weapons. Row 3: specials. Rune pouch bottom-right.
        { id: 20997 }, // Twisted bow
        { id: 27238 }, // Masori body (f)
        { id: 28951 }, // Dizana's quiver
        { id: 27610 }, // Venator bow (off-weapon, outside the zig-zag)
        { id: 33639 }, // Necklace of rupture
        { id: 27241 }, // Masori chaps (f)
        { id: 26235 }, // Zaryte vambraces
        { id: 31113 }, // Eye of Ayak (one-way magic switch)
        { id: 13652 }, // Dragon claws
        { id: 11806 }, // Saradomin godsword
        { id: 21003 }, // Elder maul
        { id: 24780 }, // Amulet of blood fury (melee healing swap)
        { id: 23685 }, // Divine super combat potion(4)
        { id: 22461 }, // Bastion potion(4); Divine bastion potion(4) is absent from the simulator catalog
        // Supplies: restores in columns 3-4 from row 4, brews in columns 1-2 from row 5.
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 27281 }, // Divine rune pouch (bottom-right utility slot)
      ]),
      supplies: {
        equippedAmmo: { id: 33595 }, // Seeking dragon arrow
        quiverAmmo: { id: 33595 }, // Seeking dragon arrow in Dizana's quiver
        runePouch: ARCEUUS_DIVINE_RUNE_POUCH,
        blowpipe: null,
        selectedSpell: null,
        spellbook: 'arceuus',
      },
    },
    mid: {
      // OSRS Wiki: /w/Fortis_Colosseum/Strategies#Ranged weapon2/head2/body3/legs2/legs3
      // rows plus #Melee_only weapon2/body3/legs3/hands2/feet2 and special2 rows; melee stays worn.
      name: 'Mid (Soulreaper Axe)',
      equipment: {
        head: 24271, // Neitiznot faceguard
        cape: 21295, // Infernal cape
        amulet: 24780, // Amulet of blood fury
        weapon: 28338, // Soulreaper axe
        body: 11832, // Bandos chestplate
        legs: 11834, // Bandos tassets
        hands: 7462, // Barrows gloves
        boots: 13239, // Primordial boots
        ring: 28307, // Ultor ring (wiki ring1)
      },
      inventory: parseInventoryFromSetup([
        // Rows 1-2: the ranged switch in zig-zag click order (slot 1, 5, 2, 6, 3, 7): bow first, then the
        // biggest-gain pieces. Column 4 holds the off-style weapons. Row 3: specials. Rune pouch bottom-right.
        { id: 25865 }, // Bow of Faerdhinen
        { id: 23979 }, // Crystal legs
        { id: 23971 }, // Crystal helm
        { id: 31113 }, // Eye of Ayak (one-way magic switch)
        { id: 23975 }, // Crystal body
        { id: 19547 }, // Necklace of anguish
        { id: 12926 }, // Toxic blowpipe (off-weapon, after the zig-zag)
        { id: 13576 }, // Dragon warhammer (Sol opening special)
        { id: 13652 }, // Dragon claws
        { id: 11806 }, // Saradomin godsword
        { id: 23685 }, // Divine super combat potion(4)
        { id: 12695 }, // Super combat potion(4)
        // Supplies: brews in columns 1-2, restores in columns 3-4; the odd pair shares row 7.
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 3024 }, // Super restore(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 27281 }, // Divine rune pouch (bottom-right utility slot)
      ]),
      supplies: {
        equippedAmmo: { id: 22947 }, // Rada's blessing 4 for the Toxic blowpipe
        quiverAmmo: null,
        runePouch: ARCEUUS_DIVINE_RUNE_POUCH,
        blowpipe: { id: 11230 }, // Dragon dart
        selectedSpell: null,
        spellbook: 'arceuus',
      },
    },
    budget: {
      // OSRS Wiki: /w/Fortis_Colosseum/Strategies#Budget — weapon1, hands1, feet3, ring1,
      // plus Melee-only weapon3, legs4, and special2 rows for the Sol-only setup.
      name: 'Budget (Tentacle)',
      equipment: {
        head: 12931, // Serpentine helm
        cape: 21295, // Infernal cape
        amulet: 24780, // Amulet of blood fury
        weapon: 12006, // Abyssal tentacle
        shield: 12954, // Dragon defender
        body: 10551, // Fighter torso
        legs: 29025, // Blood Moon tassets
        hands: 7462, // Barrows gloves
        boots: 11840, // Dragon boots (Budget feet3; echo boots are rarely run)
        ring: 11773, // Berserker ring (i)
      },
      inventory: parseInventoryFromSetup([
        // Rows 1-2: the ranged switch in zig-zag click order (slot 1, 5, 2, 6, 3): the bow first, then the
        // biggest-gain pieces. Slot 7, the next zig-zag stop, is the one free slot: the Dragon defender
        // drops there when the two-handed bow is equipped, so swapping back ends the zig-zag on it.
        { id: 25865 }, // Bow of Faerdhinen
        { id: 23979 }, // Crystal legs
        { id: 23971 }, // Crystal helm
        { id: 12899 }, // Trident of the Swamp (one-handed magic switch)
        { id: 23975 }, // Crystal body
        { id: 19547 }, // Necklace of anguish
        null, // Free: the Dragon defender lands here (first free slot) when the Bow of Faerdhinen is equipped
        { id: 12926 }, // Toxic blowpipe (off-weapon, after the zig-zag)
        { id: 13576 }, // Dragon warhammer (Sol Heredit special)
        { id: 26219 }, // Osmumten's fang
        { id: 13652 }, // Dragon claws
        { id: 11806 }, // Saradomin godsword
        { id: 12695 }, // Super combat potion(4)
        { id: 2444 }, // Ranging potion(4)
        // Supplies: restores in columns 3-4 from row 4, brews in columns 1-2 from row 5.
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 27281 }, // Divine rune pouch (bottom-right utility slot)
      ]),
      supplies: {
        equippedAmmo: { id: 22947 }, // Rada's blessing 4 for the Toxic blowpipe
        quiverAmmo: null,
        runePouch: ARCEUUS_DIVINE_RUNE_POUCH,
        blowpipe: { id: 11230 }, // Dragon dart
        selectedSpell: null,
        spellbook: 'arceuus',
      },
    },
    ironman: {
      // Midgame ironman before abyssal demons (85 Slayer). /w/Zombie_axe: "particularly useful for
      // midgame ironman players who do not have level 85 Slayer to kill abyssal demons". The rest
      // follows /w/Fortis_Colosseum/Strategies rows an ironman reaches first: Fire cape (cape2),
      // Amulet of glory (torture needs 98 Crafting for its zenyte amulet and fury 90 for onyx; glory
      // needs 80, or comes charged from drops), Trident of the Swamp
      // ("easiest to obtain for Ironmen"), Burning claws (special2), Dragon boots (Budget feet3).
      name: 'Ironman (Zombie Axe)',
      equipment: {
        head: 12931, // Serpentine helm
        cape: 6570, // Fire cape
        amulet: 1712, // Amulet of glory(4)
        weapon: 28810, // Zombie axe
        shield: 12954, // Dragon defender
        body: 10551, // Fighter torso
        legs: 29025, // Blood Moon tassets
        hands: 7462, // Barrows gloves
        boots: 11840, // Dragon boots (Budget feet3; echo boots are rarely run)
        ring: 11773, // Berserker ring (i)
      },
      inventory: parseInventoryFromSetup([
        // Rows 1-2: the ranged switch in zig-zag click order (slot 1, 5, 2, 6): the bow first, then the
        // biggest-gain pieces. The worn Amulet of glory stays on for every style (no zenyte anguish at
        // this tier). Slot 3, the next zig-zag stop, is the one free slot: the Dragon defender drops there
        // when the two-handed bow is equipped, so swapping back ends the zig-zag on it. Off-weapons fill
        // the rest of the two rows, and the specials follow straight after.
        { id: 25865 }, // Bow of Faerdhinen
        { id: 23979 }, // Crystal legs
        null, // Free: the Dragon defender lands here (first free slot) when the Bow of Faerdhinen is equipped
        { id: 12899 }, // Trident of the Swamp (one-handed magic switch)
        { id: 23975 }, // Crystal body
        { id: 23971 }, // Crystal helm
        { id: 12926 }, // Toxic blowpipe (off-weapon, after the zig-zag)
        { id: 13576 }, // Dragon warhammer (Sol Heredit special)
        { id: 29577 }, // Burning claws
        { id: 11806 }, // Saradomin godsword
        { id: 23685 }, // Divine super combat potion(4)
        { id: 12695 }, // Super combat potion(4)
        { id: 12695 }, // Super combat potion(4), in the slot the anguish freed
        // Supplies: brews in columns 1-2 (from slot 14), restores in columns 3-4.
        { id: 6685 }, // Saradomin brew(4)
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 12791 }, // Rune pouch (bottom-right utility slot)
      ]),
      supplies: {
        equippedAmmo: { id: 22945 }, // Rada's blessing 3 (hard Kourend diary) for the Toxic blowpipe
        quiverAmmo: null,
        // A standard pouch has three slots; plain Death Charge runes, no aether, for the ironman set.
        runePouch: { kind: 'standard', slots: [{ id: RUNE.blood }, { id: RUNE.soul }, { id: RUNE.death }] },
        blowpipe: { id: 25849 }, // Amethyst dart
        selectedSpell: null,
        spellbook: 'arceuus',
      },
    },
    naked: NO_EQUIPMENT_FALLBACK,
  },
  // OSRS Wiki: /w/Yama/Strategies, Phase 3 equipment and Inventory setups sections (the contract sets
  // below follow its Contracts section). The wiki inventories' Teleport to house tablet is not
  // simulated, so its slot holds one more of the set's main food; the wiki fills spare slots with food.
  yama_p3: {
    'max-mage': {
      name: 'Max Mage',
      equipment: {
        head: 21018, // Ancestral hat
        cape: 21791, // Imbued saradomin cape
        amulet: 12002, // Occult necklace
        weapon: 29594, // Purging staff
        body: 21021, // Ancestral robe top
        shield: 27251, // Elidinis' ward (f)
        legs: 21024, // Ancestral robe bottom
        hands: 31106, // Confliction gauntlets
        boots: 31097, // Avernic treads (max)
        ring: 28313, // Magus ring
      },
      inventory: parseInventoryFromSetup([
        // Slot 1: the two-handed Tumeken's shadow switch. Slot 5, the next zig-zag stop, is the one free
        // slot: the Elidinis' ward drops there. The special follows; restores in columns 3-4.
        { id: 27275 }, // Tumeken's shadow
        { id: 11806 }, // Saradomin godsword
        { id: 10925 }, // Sanfew serum(4)
        { id: 10925 }, // Sanfew serum(4)
        null, // Free: the Elidinis' ward lands here when a two-handed weapon is equipped
        { id: 13441 }, // Anglerfish
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 27641 }, // Saturated heart
        { id: 25818 }, // Book of the dead
        { id: 27281 }, // Divine rune pouch
      ]),
      supplies: YAMA_SUPPLIES,
    },
    melee: {
      name: 'Melee',
      equipment: {
        head: 28254, // Sanguine torva full helm
        cape: 21295, // Infernal cape
        amulet: 29804, // Amulet of rancour
        weapon: 29589, // Emberlight
        body: 30779, // Radiant oathplate chest
        shield: 22322, // Avernic defender
        legs: 30781, // Radiant oathplate legs
        hands: 22981, // Ferocious gloves
        boots: 31097, // Avernic treads (max)
        ring: 28307, // Ultor ring
      },
      inventory: parseInventoryFromSetup([
        // Slots 1, 5, 2: the magic switch in zig-zag order. Slot 6, the next stop, is the one free slot:
        // the Avernic defender drops there when a two-handed special is equipped. Specials follow.
        { id: 29594 }, // Purging staff
        { id: 31106 }, // Confliction gauntlets
        { id: 21003 }, // Elder maul
        { id: 29577 }, // Burning claws
        { id: 12002 }, // Occult necklace
        null, // Free: the Avernic defender lands here when a two-handed weapon is equipped
        { id: 11806 }, // Saradomin godsword
        { id: 23685 }, // Divine super combat potion(4)
        // Supplies: restores in columns 3-4, anglerfish in columns 1-2 and every slot left over.
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 10925 }, // Sanfew serum(4)
        { id: 3024 }, // Super restore(4)
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 3024 }, // Super restore(4)
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 25818 }, // Book of the dead
        { id: 27281 }, // Divine rune pouch
      ]),
      supplies: YAMA_SUPPLIES,
    },
    hybrid: {
      name: 'Melee and Mage',
      equipment: {
        head: 28254, // Sanguine torva full helm
        cape: 21295, // Infernal cape
        amulet: 29804, // Amulet of rancour
        weapon: 29589, // Emberlight
        body: 30779, // Radiant oathplate chest
        shield: 22322, // Avernic defender
        legs: 30781, // Radiant oathplate legs
        hands: 22981, // Ferocious gloves
        boots: 31097, // Avernic treads (max)
        ring: 28307, // Ultor ring
      },
      inventory: parseInventoryFromSetup([
        // Rows 1-2: the eight-piece magic switch in zig-zag order (1, 5, 2, 6, 3, 7, 4, 8). Slot 9, the
        // next stop, is the one free slot: the Avernic defender drops there when a two-handed weapon is
        // equipped. Row 3: specials, then the Tumeken's shadow off-weapon in column 4.
        { id: 29594 }, // Purging staff
        { id: 31106 }, // Confliction gauntlets
        { id: 21024 }, // Ancestral robe bottom
        { id: 28313 }, // Magus ring
        { id: 12002 }, // Occult necklace
        { id: 21021 }, // Ancestral robe top
        { id: 21791 }, // Imbued saradomin cape
        { id: 21018 }, // Ancestral hat
        null, // Free: the Avernic defender lands here when a two-handed weapon is equipped
        { id: 21003 }, // Elder maul
        { id: 11806 }, // Saradomin godsword
        { id: 27275 }, // Tumeken's shadow (off-weapon, outside the zig-zag)
        { id: 23685 }, // Divine super combat potion(4)
        { id: 13441 }, // Anglerfish
        { id: 10925 }, // Sanfew serum(4)
        { id: 3024 }, // Super restore(4)
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 3024 }, // Super restore(4)
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 27641 }, // Saturated heart
        { id: 25818 }, // Book of the dead
        { id: 27281 }, // Divine rune pouch
      ]),
      supplies: YAMA_SUPPLIES,
    },
    'learner-mage': {
      name: 'Learner (Mage)',
      equipment: {
        head: 29019, // Blue moon helm
        cape: 21791, // Imbued saradomin cape
        amulet: 12002, // Occult necklace
        weapon: 29594, // Purging staff
        body: 29013, // Blue moon chestplate
        shield: 6889, // Mage's book
        legs: 29016, // Blue moon tassets
        hands: 19544, // Tormented bracelet
        boots: 6920, // Infinity boots
        ring: 11770, // Seers ring (i)
      },
      inventory: parseInventoryFromSetup([
        // No switches. Brews and anglerfish in columns 1-2, restores and karambwans (the combo-eat
        // partner) in columns 3-4. The Antidote++ sits with the utilities, used once if at all.
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 3024 }, // Super restore(4)
        { id: 3024 }, // Super restore(4)
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 3144 }, // Cooked karambwan
        { id: 3144 }, // Cooked karambwan
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 3144 }, // Cooked karambwan
        { id: 3144 }, // Cooked karambwan
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 3144 }, // Cooked karambwan
        { id: 3144 }, // Cooked karambwan
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 3144 }, // Cooked karambwan
        { id: 3144 }, // Cooked karambwan
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 5952 }, // Antidote++(4)
        { id: 25818 }, // Book of the dead
        { id: 27281 }, // Divine rune pouch
      ]),
      supplies: YAMA_SUPPLIES,
    },
    naked: NO_EQUIPMENT_FALLBACK,
  },
  // Contract sets: /w/Yama/Strategies#Contracts. A contract is used up when the fight starts, so no
  // set keeps a slot for it. Each set's one free slot is where the worn off-hand drops when a
  // two-handed weapon is equipped.
  yama_p3_forfeit_breath: {
    mage: {
      name: 'Mage',
      equipment: {
        head: 21018, // Ancestral hat
        cape: 21793, // Imbued guthix cape
        amulet: 12002, // Occult necklace
        weapon: 29594, // Purging staff
        body: 21021, // Ancestral robe top
        shield: 27251, // Elidinis' ward (f)
        legs: 21024, // Ancestral robe bottom
        hands: 31106, // Confliction gauntlets
        boots: 31097, // Avernic treads (max)
        ring: 24736, // Ring of endurance (charged)
      },
      inventory: parseInventoryFromSetup([
        // No style switch: the special leads, the Elidinis' ward drops into the free slot below it, and
        // the Eye of Ayak off-weapon sits in column 4. The run-energy potions, the contract's answer to
        // its drain, go first among the supplies.
        { id: 11806 }, // Saradomin godsword
        { id: 31638 }, // Extended stamina potion(4)
        { id: 31614 }, // Extreme energy potion(4)
        { id: 31113 }, // Eye of Ayak (off-weapon)
        null, // Free: the Elidinis' ward lands here when a two-handed weapon is equipped
        { id: 31614 }, // Extreme energy potion(4)
        { id: 31614 }, // Extreme energy potion(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 29143 }, // Cooked moonlight antelope
        { id: 29143 }, // Cooked moonlight antelope
        { id: 10925 }, // Sanfew serum(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 29143 }, // Cooked moonlight antelope
        { id: 29143 }, // Cooked moonlight antelope
        { id: 10925 }, // Sanfew serum(4)
        { id: 13441 }, // Anglerfish
        { id: 29143 }, // Cooked moonlight antelope
        { id: 29143 }, // Cooked moonlight antelope
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 29143 }, // Cooked moonlight antelope
        { id: 3144 }, // Cooked karambwan
        { id: 3144 }, // Cooked karambwan
        { id: 3144 }, // Cooked karambwan
        { id: 561 }, // Nature rune
        { id: 27641 }, // Saturated heart
        { id: 25818 }, // Book of the dead
        { id: 27281 }, // Divine rune pouch
      ]),
      supplies: YAMA_SUPPLIES,
    },
    naked: NO_EQUIPMENT_FALLBACK,
  },
  yama_p3_glyphic: {
    melee: {
      name: 'Melee',
      equipment: {
        head: 28933, // Sunfire fanatic helm
        cape: 13124, // Ardougne cloak 4
        amulet: 22986, // Bonecrusher necklace
        // Kept although weapon verification lists a gap: only its Spike (stab) style is unverified,
        // and Glyphic leaves stab useless. Its crush styles are verified from the Glyphic captures.
        weapon: 24417, // Inquisitor's mace
        body: 28936, // Sunfire fanatic cuirass
        shield: 22322, // Avernic defender
        legs: 28939, // Sunfire fanatic chausses
        hands: 22981, // Ferocious gloves
        boots: 22954, // Devout boots
        ring: 13202, // Ring of the gods (i)
      },
      inventory: parseInventoryFromSetup([
        // No style switch: the specials lead (the crush Elder maul first), the Avernic defender drops
        // into the free slot below them, and the one-way Purging staff magic switch sits in column 4.
        { id: 21003 }, // Elder maul
        { id: 11806 }, // Saradomin godsword
        { id: 12695 }, // Super combat potion(4)
        { id: 29594 }, // Purging staff (one-way magic switch)
        null, // Free: the Avernic defender lands here when a two-handed weapon is equipped
        { id: 12695 }, // Super combat potion(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 10925 }, // Sanfew serum(4)
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 25818 }, // Book of the dead
        { id: 27281 }, // Divine rune pouch
      ]),
      supplies: YAMA_SUPPLIES,
    },
    naked: NO_EQUIPMENT_FALLBACK,
  },
  yama_p3_sensory: {
    mage: {
      name: 'Mage',
      equipment: {
        head: 21018, // Ancestral hat
        cape: 21793, // Imbued guthix cape
        amulet: 12002, // Occult necklace
        weapon: 29594, // Purging staff
        body: 21021, // Ancestral robe top
        shield: 27251, // Elidinis' ward (f)
        legs: 21024, // Ancestral robe bottom
        hands: 31106, // Confliction gauntlets
        boots: 31097, // Avernic treads (max)
        ring: 25975, // Lightbearer
      },
      inventory: parseInventoryFromSetup([
        // No style switch: the specials lead, the Elidinis' ward drops into the free slot below them,
        // and the Scorching bow, a one-way switch for its demon-binding special, sits in column 4.
        { id: 11806 }, // Saradomin godsword
        // Kept although weapon verification lists a gap: its ordinary casts all splashed in the captures,
        // but it is carried for its Condemn special, which is verified.
        { id: 27665 }, // Accursed sceptre
        { id: 27629 }, // Forgotten brew(4)
        { id: 29591 }, // Scorching bow (one-way bind switch)
        null, // Free: the Elidinis' ward lands here when a two-handed weapon is equipped
        { id: 30875 }, // Surge potion(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 6685 }, // Saradomin brew(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 561 }, // Nature rune
        { id: 27641 }, // Saturated heart
        { id: 25818 }, // Book of the dead
        { id: 27281 }, // Divine rune pouch
      ]),
      supplies: YAMA_SENSORY_SUPPLIES,
    },
    naked: NO_EQUIPMENT_FALLBACK,
  },
  yama_p3_divine: {
    mage: {
      name: 'Mage',
      equipment: {
        head: 21018, // Ancestral hat
        cape: 21793, // Imbued guthix cape
        amulet: 12002, // Occult necklace
        weapon: 29594, // Purging staff
        body: 21021, // Ancestral robe top
        shield: 27251, // Elidinis' ward (f)
        legs: 21024, // Ancestral robe bottom
        hands: 31106, // Confliction gauntlets
        boots: 31097, // Avernic treads (max)
        ring: 28313, // Magus ring
      },
      inventory: parseInventoryFromSetup([
        // No style switch: the specials lead and the Elidinis' ward drops into the free slot below them.
        // Restores in columns 3-4; antelope, the main food, in columns 1-2.
        { id: 11806 }, // Saradomin godsword
        // Kept although weapon verification lists a gap: its ordinary casts all splashed in the captures,
        // but it is carried for its Condemn special, which is verified.
        { id: 27665 }, // Accursed sceptre
        { id: 10925 }, // Sanfew serum(4)
        { id: 10925 }, // Sanfew serum(4)
        null, // Free: the Elidinis' ward lands here when a two-handed weapon is equipped
        { id: 29143 }, // Cooked moonlight antelope
        { id: 10925 }, // Sanfew serum(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 29143 }, // Cooked moonlight antelope
        { id: 29143 }, // Cooked moonlight antelope
        { id: 29143 }, // Cooked moonlight antelope
        { id: 13441 }, // Anglerfish
        { id: 29143 }, // Cooked moonlight antelope
        { id: 29143 }, // Cooked moonlight antelope
        { id: 13441 }, // Anglerfish
        { id: 13441 }, // Anglerfish
        { id: 29143 }, // Cooked moonlight antelope
        { id: 29143 }, // Cooked moonlight antelope
        { id: 13441 }, // Anglerfish
        { id: 3144 }, // Cooked karambwan
        { id: 29143 }, // Cooked moonlight antelope
        { id: 29143 }, // Cooked moonlight antelope
        { id: 3144 }, // Cooked karambwan
        { id: 3144 }, // Cooked karambwan
        { id: 561 }, // Nature rune
        { id: 27641 }, // Saturated heart
        { id: 25818 }, // Book of the dead
        { id: 27281 }, // Divine rune pouch
      ]),
      supplies: YAMA_SUPPLIES,
    },
    naked: NO_EQUIPMENT_FALLBACK,
  },
  yama_p3_bloodied: {
    mage: {
      name: 'Mage',
      equipment: {
        head: 21018, // Ancestral hat
        cape: 21793, // Imbued guthix cape
        amulet: 12002, // Occult necklace
        weapon: 29594, // Purging staff
        body: 21021, // Ancestral robe top
        shield: 27251, // Elidinis' ward (f)
        legs: 21024, // Ancestral robe bottom
        hands: 31106, // Confliction gauntlets
        boots: 31097, // Avernic treads (max)
        ring: 28313, // Magus ring
      },
      inventory: parseInventoryFromSetup([
        // No style switch: the special leads, the Elidinis' ward drops into the free slot below it, and
        // the Eye of Ayak off-weapon sits in column 4. The Locator orb and rock cake, which hold hitpoints
        // low for Wretched Strength, sit with the utilities.
        { id: 11806 }, // Saradomin godsword
        { id: 29143 }, // Cooked moonlight antelope
        { id: 29143 }, // Cooked moonlight antelope
        { id: 31113 }, // Eye of Ayak (off-weapon)
        null, // Free: the Elidinis' ward lands here when a two-handed weapon is equipped
        { id: 29143 }, // Cooked moonlight antelope
        { id: 10925 }, // Sanfew serum(4)
        { id: 10925 }, // Sanfew serum(4)
        { id: 29183 }, // Snowy knight mix(2)
        { id: 29183 }, // Snowy knight mix(2)
        { id: 4417 }, // Guthix rest(4)
        { id: 4417 }, // Guthix rest(4)
        { id: 29183 }, // Snowy knight mix(2)
        { id: 29183 }, // Snowy knight mix(2)
        { id: 4417 }, // Guthix rest(4)
        { id: 4417 }, // Guthix rest(4)
        { id: 29183 }, // Snowy knight mix(2)
        { id: 29183 }, // Snowy knight mix(2)
        { id: 4417 }, // Guthix rest(4)
        { id: 4417 }, // Guthix rest(4)
        { id: 4417 }, // Guthix rest(4)
        { id: 4417 }, // Guthix rest(4)
        { id: 22081 }, // Locator orb
        { id: 7510 }, // Dwarven rock cake
        { id: 561 }, // Nature rune
        { id: 27641 }, // Saturated heart
        { id: 25818 }, // Book of the dead
        { id: 27281 }, // Divine rune pouch
      ]),
      supplies: YAMA_SUPPLIES,
    },
    naked: NO_EQUIPMENT_FALLBACK,
  },
};

// The Duke practice loadout uses the user's opening switches and supply counts.
// https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode
const dukePracticeEquipment = { ...EQUIPMENT_PRESETS.sol_heredit.max.equipment, head: 30750, weapon: 29577 };
const dukePracticeInventory = parseInventoryFromSetup([
  { id: 29589 }, // Emberlight
  { id: 12695 }, // Super combat potion(4)
  { id: 12695 }, // Super combat potion(4)
  { id: 22325 }, // Scythe of Vitur
  { id: 22322 }, // Avernic defender
  { id: 6685 }, // Saradomin brew(4)
  { id: 3024 }, // Super restore(4)
  { id: 3024 }, // Super restore(4)
  { id: 6685 }, // Saradomin brew(4)
  { id: 6685 }, // Saradomin brew(4)
  { id: 3024 }, // Super restore(4)
  { id: 3024 }, // Super restore(4)
  { id: 6685 }, // Saradomin brew(4)
  { id: 6685 }, // Saradomin brew(4)
  { id: 3024 }, // Super restore(4)
  ...Array.from({ length: 3 }, () => [{ id: HALIBUT_ITEM_ID }, { id: 13441 }, { id: 13441 }, { id: 13441 }]).flat(),
  { id: ARDER_MUSCA_POISON_ITEM_ID, q: 3 }, // Arder-musca poison
]);

const unarmedDukeInventory = createEmptyInventory();
unarmedDukeInventory[27] = dukePracticeInventory[27];

EQUIPMENT_PRESETS.duke_practice = {
  burning_claws: { name: 'Max (Burning claws)', equipment: dukePracticeEquipment, inventory: dukePracticeInventory },
  emberlight: {
    name: 'Max (Emberlight)',
    equipment: { ...dukePracticeEquipment, weapon: 29589, shield: 22322 },
    inventory: dukePracticeInventory.map((item) => {
      if (item?.id === 29589) return { id: 29577 }; // Burning claws replace Emberlight.
      if (item?.id === 22322) return null; // The defender is worn.
      return item;
    }),
  },
  scythe: {
    name: 'Max (Scythe)',
    equipment: { ...dukePracticeEquipment, weapon: 22325 },
    inventory: dukePracticeInventory.map((item) => (item?.id === 22325 ? { id: 29577 } : item)),
  },
  naked: { ...NO_EQUIPMENT_FALLBACK, inventory: unarmedDukeInventory },
};

// Derive every real set's requirements from the items it uses (see itemRequirements.ts),
// so a set is only selectable when the player can wield/wear all of its gear. The
// No-Equipment fallback stays requirement-free by design.
for (const group of new Set(Object.values(EQUIPMENT_PRESETS))) {
  for (const [key, preset] of Object.entries(group)) {
    if (preset.isFallback) {
      continue;
    }
    group[key] = { ...preset, requirements: computeSetRequirements(preset.equipment, preset.inventory) };
  }
}
