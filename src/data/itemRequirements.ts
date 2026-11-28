import type { PlayerEquipment } from '../rs/model/PlayerModelLoader';
import type { Inventory } from '../types/inventory';
import type { PresetRequirements } from '../types/player';
import { PLAYER_STAT_KEYS } from '../types/playerState';

/**
 * Minimum skill levels required to EQUIP/WIELD each item used across the equipment
 * presets, sourced from the official OSRS Wiki (oldschool.runescape.wiki, retrieved
 * 2026-07). Only items with a real wield/wear requirement appear here; items with no
 * level gate (most amulets, rings, capes, gloves, food, potions, runes, teleports) are
 * intentionally omitted and contribute nothing to a set's requirements.
 *
 * A preset's requirements are DERIVED from this table via {@link computeSetRequirements}
 * as the maximum per skill across every item the set uses (equipment + inventory), so a
 * set is only selectable when the player can actually use all of its gear. This is the
 * single source of truth — {@link EQUIPMENT_PRESETS} does not hand-tune requirements.
 *
 * Cosmetic/upgraded variants that share a base item's requirement are keyed separately
 * (e.g. Sanguine Torva, Radiant Oathplate, Avernic treads (max)).
 */
export const ITEM_WIELD_REQUIREMENTS: Record<number, PresetRequirements> = {
  22325: { attack: 80, strength: 90 }, // Scythe of vitur — /w/Scythe_of_vitur
  21003: { attack: 75, strength: 75 }, // Elder maul — /w/Elder_maul
  26219: { attack: 82 }, // Osmumten's fang — /w/Osmumten's_fang
  24417: { attack: 80 }, // Inquisitor's mace — /w/Inquisitor's_mace (raised to 80 in 2022)
  29589: { attack: 77 }, // Emberlight — /w/Emberlight
  11806: { attack: 75 }, // Saradomin godsword — /w/Saradomin_godsword (Attack only, no Strength)
  27690: { attack: 75 }, // Voidwaker — /w/Voidwaker (Attack only)
  12006: { attack: 75 }, // Abyssal tentacle — /w/Abyssal_tentacle
  13652: { attack: 60 }, // Dragon claws — /w/Dragon_claws
  29577: { attack: 60 }, // Burning claws — /w/Burning_claws
  22322: { attack: 70, defence: 70 }, // Avernic defender — /w/Avernic_defender

  27275: { magic: 85 }, // Tumeken's shadow — /w/Tumeken's_shadow
  31113: { magic: 83 }, // Eye of ayak — /w/Eye_of_ayak
  29594: { attack: 50, magic: 77 }, // Purging staff — /w/Purging_staff (demonbane battlestaff)
  27679: { magic: 70 }, // Accursed sceptre (a) — /w/Accursed_sceptre_(a)
  6889: { magic: 60 }, // Mage's book — /w/Mage's_book
  29591: { ranged: 77 }, // Scorching bow — /w/Scorching_bow
  20997: { ranged: 85 }, // Twisted bow — /w/Twisted_bow
  23983: { ranged: 70 }, // Crystal bow — /w/Crystal_bow (also 50 Agility and Roving Elves, not combat stats)
  24123: { ranged: 70 }, // Crystal bow (new)
  25865: { ranged: 80 }, // Bow of faerdhinen (c) — /w/Bow_of_faerdhinen (also 70 Agility, not a combat stat)
  12926: { ranged: 75 }, // Toxic blowpipe — /w/Toxic_blowpipe
  29000: { ranged: 75, attack: 50, strength: 50 }, // Eclipse atlatl — /w/Eclipse_atlatl (Attack/Strength added 27 March 2024)
  11785: { ranged: 70 }, // Armadyl crossbow — /w/Armadyl_crossbow (fires up to dragon bolts)
  21902: { ranged: 64 }, // Dragon crossbow — /w/Dragon_crossbow (fires up to dragon bolts)
  9185: { ranged: 61 }, // Rune crossbow — /w/Rune_crossbow (fires up to RUNITE bolts — no dragon bolts)
  21006: { magic: 80 }, // Kodai wand — /w/Kodai_wand
  27624: { magic: 70, strength: 60, attack: 50 }, // Ancient sceptre — /w/Ancient_sceptre
  30070: { magic: 65 }, // Dragon hunter wand — /w/Dragon_hunter_wand
  6914: { magic: 60 }, // Master wand — /w/Master_wand
  24422: { magic: 72, hitpoints: 50 }, // Nightmare staff — /w/Nightmare_staff (72 Magic since 11 May 2022)
  24424: { magic: 82, hitpoints: 50 }, // Volatile Nightmare staff — /w/Nightmare_staff (an orb raises it to 82)
  24425: { magic: 82, hitpoints: 50 }, // Eldritch Nightmare staff — /w/Eldritch_Nightmare_staff

  26382: { defence: 80 }, // Torva full helm — /w/Torva_full_helm
  28254: { defence: 80 }, // Sanguine torva full helm (cosmetic Torva variant)
  26384: { defence: 80 }, // Torva platebody — /w/Torva_platebody
  26386: { defence: 80 }, // Torva platelegs — /w/Torva_platelegs
  30750: { defence: 78 }, // Oathplate helm — /w/Oathplate_helm
  30753: { defence: 78 }, // Oathplate chest — /w/Oathplate_chest
  30756: { defence: 78 }, // Oathplate legs — /w/Oathplate_legs
  30779: { defence: 78 }, // Radiant oathplate chest (recolor of Oathplate chest)
  30781: { defence: 78 }, // Radiant oathplate legs (recolor of Oathplate legs)
  22981: { attack: 80, defence: 80 }, // Ferocious gloves — /w/Ferocious_gloves
  12931: { defence: 75 }, // Serpentine helm — /w/Serpentine_helm
  12954: { defence: 60 }, // Dragon defender — /w/Dragon_defender
  28945: { defence: 75 }, // Echo boots — /w/Echo_boots
  29025: { strength: 75, defence: 50 }, // Blood moon tassets — /w/Blood_moon_tassets
  10551: { defence: 40 }, // Fighter torso — /w/Fighter_torso
  22326: { defence: 75 }, // Justiciar faceguard — /w/Justiciar_faceguard
  4753: { defence: 70 }, // Verac's helm — /w/Verac's_helm
  21733: { defence: 75 }, // Guardian boots — /w/Guardian_boots

  27235: { ranged: 80, defence: 80 }, // Masori mask (f) — /w/Masori_mask_(f)
  27238: { ranged: 80, defence: 80 }, // Masori body (f) — /w/Masori_body_(f)
  27241: { ranged: 80, defence: 80 }, // Masori chaps (f) — /w/Masori_chaps_(f)
  26235: { ranged: 80, defence: 45 }, // Zaryte vambraces — /w/Zaryte_vambraces
  13237: { ranged: 75, defence: 75 }, // Pegasian boots — /w/Pegasian_boots
  22109: { ranged: 70 }, // Ava's assembler — /w/Ava's_assembler
  23971: { defence: 70 }, // Crystal helm — /w/Crystal_helm (also 50 Agility, not a combat stat)
  23975: { defence: 70 }, // Crystal body — /w/Crystal_body (also 50 Agility)
  23979: { defence: 70 }, // Crystal legs — /w/Crystal_legs (also 50 Agility)
  29035: { ranged: 75, defence: 50 }, // Eclipse moon helm — /w/Eclipse_moon_helm
  29031: { ranged: 75, defence: 50 }, // Eclipse moon chestplate — /w/Eclipse_moon_chestplate
  29033: { ranged: 75, defence: 50 }, // Eclipse moon tassets — /w/Eclipse_moon_tassets
  30076: { ranged: 70, defence: 40 }, // Hueycoatl hide body — /w/Hueycoatl_hide_body
  30079: { ranged: 70 }, // Hueycoatl hide chaps — /w/Hueycoatl_hide_chaps
  12492: { ranged: 70, defence: 40 }, // Ancient d'hide body — /w/Ancient_d'hide_body (blessed dragonhide)
  12494: { ranged: 70 }, // Ancient chaps — /w/Ancient_chaps (blessed dragonhide)
  19921: { ranged: 70, defence: 40 }, // Ancient d'hide boots — /w/Ancient_d'hide_boots (blessed dragonhide)

  21018: { magic: 75, defence: 65 }, // Ancestral hat — /w/Ancestral_hat
  21021: { magic: 75, defence: 65 }, // Ancestral robe top — /w/Ancestral_robe_top
  21024: { magic: 75, defence: 65 }, // Ancestral robe bottom — /w/Ancestral_robe_bottom
  27251: { magic: 80, defence: 80, prayer: 80 }, // Elidinis' ward (f) — /w/Elidinis'_ward_(f)
  6920: { magic: 50, defence: 25 }, // Infinity boots — /w/Infinity_boots (50 Magic, 25 Defence)
  29019: { magic: 75, defence: 50 }, // Blue moon helm — /w/Blue_moon_helm
  29013: { magic: 75, defence: 50 }, // Blue moon chestplate — /w/Blue_moon_chestplate
  29016: { magic: 75, defence: 50 }, // Blue moon tassets — /w/Blue_moon_tassets
  29037: { magic: 75, defence: 50 }, // Blue moon chestplate (used variant) — /w/Blue_moon_chestplate
  26243: { magic: 78, defence: 75 }, // Virtus robe top — /w/Virtus_robe_top
  26245: { magic: 78, defence: 75 }, // Virtus robe bottom — /w/Virtus_robe_bottom
  4712: { magic: 70, defence: 70 }, // Ahrim's robetop — /w/Ahrim's_robetop
  4714: { magic: 70, defence: 70 }, // Ahrim's robeskirt — /w/Ahrim's_robeskirt
  25404: { magic: 60, defence: 60 }, // Bloodbark body — /w/Bloodbark_body
  25416: { magic: 60, defence: 60 }, // Bloodbark legs — /w/Bloodbark_legs
  12002: { magic: 70 }, // Occult necklace — /w/Occult_necklace

  28933: { prayer: 60, defence: 40 }, // Sunfire fanatic helm — /w/Sunfire_fanatic_helm
  28936: { prayer: 60, defence: 40 }, // Sunfire fanatic cuirass — /w/Sunfire_fanatic_cuirass
  28939: { prayer: 60, defence: 40 }, // Sunfire fanatic chausses — /w/Sunfire_fanatic_chausses
  22954: { prayer: 60 }, // Devout boots — /w/Devout_boots
  22986: { prayer: 70 }, // Bonecrusher necklace — /w/Bonecrusher_necklace
  12817: { defence: 75, prayer: 75 }, // Elysian spirit shield — /w/Elysian_spirit_shield (75 Def + 75 Prayer)

  31097: { defence: 80, strength: 80, ranged: 80, magic: 80 }, // Avernic treads (max) — /w/Avernic_treads
  31106: { hitpoints: 90 }, // Confliction gauntlets — /w/Confliction_gauntlets
  19544: { hitpoints: 75 }, // Tormented bracelet — /w/Tormented_bracelet
  29801: { hitpoints: 90 }, // Amulet of rancour — /w/Amulet_of_rancour
  29804: { hitpoints: 90 }, // Amulet of rancour (s) (recolor of Amulet of rancour)
};

export function computeSetRequirements(equipment: PlayerEquipment, inventory: Inventory): PresetRequirements {
  const requirements: PresetRequirements = {};

  const applyItem = (id: number): void => {
    const itemReq = ITEM_WIELD_REQUIREMENTS[id];
    if (!itemReq) {
      return;
    }
    for (const stat of PLAYER_STAT_KEYS) {
      const level = itemReq[stat];
      if (level !== undefined && level > (requirements[stat] ?? 0)) {
        requirements[stat] = level;
      }
    }
  };

  for (const id of Object.values(equipment)) {
    if (typeof id === 'number') {
      applyItem(id);
    }
  }
  for (const slot of inventory) {
    if (slot) {
      applyItem(slot.id);
    }
  }

  return requirements;
}
