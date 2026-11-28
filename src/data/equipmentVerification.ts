/**
 * Weapons we have checked ourselves, end to end: every aspect below is either backed by our own
 * evidence (a capture or an audit that cites one) or does not apply to the weapon. A weapon missing
 * from this list is unverified unless explicitly listed in `WEAPON_VERIFICATION_LIMITATIONS`.
 * Both lists must still pass the automatic checks in `equipmentSupport.ts`, so a stale entry
 * cannot hide a regression.
 *
 * Keyed by exact item id, not by combat family: a cosmetic or charged variant can swing, sound or
 * fire differently (the Blazing blowpipe has its own animation), so each variant is listed only
 * once someone has observed that variant. The one exception is a family whose variants differ only
 * in ids the cache names per variant: the Bow of Faerdhinen colors share one recorded shot.
 *
 * A staff shows the spell it casts, and its own bash hardly matters, so its animation, sound and
 * projectile are `spell`: judged per spell in `spellVisuals.ts`, not per staff. What makes a staff
 * verified is the staff itself: its category, its passive, and its special attack if it has one.
 *
 * To add a fully verified weapon, cite evidence for all four aspects. A special attack must be
 * simulated, damage included, before a weapon with one can be listed in `VERIFIED_WEAPONS`.
 */

/**
 * What establishes an aspect: repo paths (optionally `#section`), or `capture:<file name>` for one of
 * the private gameplay captures, cited by name.
 */
export type Evidence = readonly [string, ...string[]];

/** A staff's attack is the spell it casts, which is verified per spell rather than per staff. */
type SpellDriven = 'spell';

export interface WeaponVerification {
  readonly name: string;
  readonly animation: Evidence | SpellDriven;
  readonly sound: Evidence | SpellDriven;
  /** `none` for weapons that fire nothing of their own, such as melee. */
  readonly projectile: Evidence | 'none' | SpellDriven;
  /** `none` only for weapons without a special attack in OSRS. */
  readonly special: Evidence | 'none';
}

const SOUND_AUDIT = 'docs/architecture/audio-sound-ids.md#2-player-weapon-and-spell-sounds';
const MELEE_STYLES_CAPTURE =
  'capture:weapon-attacks-zamorakian-hasta-abyssal-bludgeon-sarachnis-cudgel-packet-data.txt';
const BLOWPIPE_BOWFA_CAPTURE = 'capture:blowpipe-spec-bowfa-attacks-packet-data.txt';
const CRYSTAL_BOW_OBSERVATION = 'docs/research/crystal-bow.md#shot';
const INFERNO_CAPTURE = 'capture:inferno-waves-69-zuk-packet-data.txt';
const BLUDGEON_SPECIAL_CAPTURE = 'capture:abyssal-bludgeon-special-attack-packet-data.txt';
const COLOSSEUM_CAPTURE = 'capture:colosseum-no-sol-packet-data.txt';
const YAMA_FORFEIT_BREATH_CAPTURE = 'capture:yama_forfeit_breath.txt';
const TOB_CAPTURE = 'capture:tob-hmt-5-packet-data-3.txt';
const INFERNO_ORNAMENT_BLOWPIPE_CAPTURE = 'capture:inferno-waves-(35ish)-to-68-packet-data.txt';
/** One or more swings on every attack style of each weapon it covers, plus several specials. */
const WEAPON_SWEEP_CAPTURE =
  'capture:weapon-attacks-sgs-elder-maul-burning-claws-tbow-emberlight-accursed-sceptre-ghrazi-rapier-dragon-claws-scythe-bowfa-whip-tentacle-dhl-zspear-hasta-dscim-ags-zgs-voidwaker-dragon-pickaxe-packet-data.txt';
const BURNING_CLAWS_SPECIAL_CAPTURE = 'capture:burning-claws-special-attack-packet-data.txt';
/**
 * Every style and special of each weapon it names, swung at a POH combat dummy whose splat is the
 * max hit; the tridents on every style.
 */
const SOULREAPER_FANG_TRIDENTS_CAPTURE =
  'capture:weapon-soulreaper-fang-dragonwarhammer-zombieaxe-noxhalberd-tridentoftheswamps-tridentoftheseas-packet-data.txt';
const SENSORY_CLOUDING_CAPTURES: Evidence = [
  'capture:yama-contract-of-sensory-clouding-packet-data-1(incomplete).txt',
  'capture:yama-contract-of-sensory-clouding-p3-contributed-packet-data(incomplete).txt',
];

/**
 * Every color fires Trahaearn's recorded shot (animation, sound, heights, timing); only its launch and
 * travel spotanims differ, and those are the cache's own per-color names in `BOWFA_VISUALS`.
 */
function bowOfFaerdhinen(name: string): WeaponVerification {
  return {
    name,
    animation: [BLOWPIPE_BOWFA_CAPTURE],
    sound: [BLOWPIPE_BOWFA_CAPTURE],
    projectile: [BLOWPIPE_BOWFA_CAPTURE, 'src/data/weaponCombatVisuals.ts'],
    special: 'none',
  };
}

/** Checked in game rather than captured; it plays the Bowfa's recorded sound. */
function crystalBow(name: string): WeaponVerification {
  return {
    name,
    animation: [CRYSTAL_BOW_OBSERVATION],
    sound: [CRYSTAL_BOW_OBSERVATION, BLOWPIPE_BOWFA_CAPTURE],
    projectile: [CRYSTAL_BOW_OBSERVATION, 'src/data/weaponCombatVisuals.generated.ts'],
    special: 'none',
  };
}

/** A staff with no special attack of its own; any passive is named where it is implemented. */
function plainStaff(name: string): WeaponVerification {
  return { name, animation: 'spell', sound: 'spell', projectile: 'spell', special: 'none' };
}

/** A melee weapon whose every style, and its special if any, is in that capture. */
function capturedMelee(name: string, hasSpecial: boolean): WeaponVerification {
  return {
    name,
    animation: [SOULREAPER_FANG_TRIDENTS_CAPTURE],
    sound: [SOULREAPER_FANG_TRIDENTS_CAPTURE],
    projectile: 'none',
    special: hasSpecial ? [SOULREAPER_FANG_TRIDENTS_CAPTURE] : 'none',
  };
}

/**
 * The full and partly charged Trident of the seas are one item: the capture cannot tell which it held.
 * The (e) version differs only in charge capacity (20,000 rather than 2,500; OSRS Wiki, Trident of
 * the seas (e)), so it shares the evidence.
 */
function tridentOfTheSeas(name: string): WeaponVerification {
  return {
    name,
    animation: [SOULREAPER_FANG_TRIDENTS_CAPTURE],
    sound: [SOULREAPER_FANG_TRIDENTS_CAPTURE],
    projectile: [SOULREAPER_FANG_TRIDENTS_CAPTURE, 'src/data/weaponCombatVisuals.ts'],
    special: 'none',
  };
}

function abyssalTentacle(name: string): WeaponVerification {
  return {
    name,
    animation: [WEAPON_SWEEP_CAPTURE],
    sound: [WEAPON_SWEEP_CAPTURE],
    projectile: 'none',
    special: [WEAPON_SWEEP_CAPTURE],
  };
}

export const VERIFIED_WEAPONS: Readonly<Record<number, WeaponVerification>> = {
  13263: {
    name: 'Abyssal bludgeon',
    animation: [MELEE_STYLES_CAPTURE],
    sound: [MELEE_STYLES_CAPTURE, BLUDGEON_SPECIAL_CAPTURE],
    projectile: 'none',
    // Penance: /w/Abyssal_bludgeon § Special attack, in `playerAttackProfileSelection.ts`; its
    // animation, sounds and target graphic are all in the capture.
    special: [BLUDGEON_SPECIAL_CAPTURE],
  },
  23528: {
    name: 'Sarachnis cudgel',
    animation: [MELEE_STYLES_CAPTURE],
    sound: [MELEE_STYLES_CAPTURE],
    projectile: 'none',
    special: 'none',
  },
  12926: {
    name: 'Toxic blowpipe',
    animation: [INFERNO_CAPTURE],
    sound: [SOUND_AUDIT, BLOWPIPE_BOWFA_CAPTURE],
    projectile: [INFERNO_CAPTURE],
    special: [INFERNO_CAPTURE, BLOWPIPE_BOWFA_CAPTURE],
  },
  28688: {
    name: 'Blazing blowpipe',
    // 853/853 ornament swings play 2696 and fire the loaded dart at the toxic blowpipe's heights and
    // timing; the special's projectile and sounds are the ornament's own.
    animation: [INFERNO_ORNAMENT_BLOWPIPE_CAPTURE],
    sound: [INFERNO_ORNAMENT_BLOWPIPE_CAPTURE, BLOWPIPE_BOWFA_CAPTURE],
    projectile: [INFERNO_ORNAMENT_BLOWPIPE_CAPTURE],
    special: [BLOWPIPE_BOWFA_CAPTURE],
  },
  23983: crystalBow('Crystal bow'),
  24123: crystalBow('Crystal bow (new)'),
  25865: bowOfFaerdhinen('Bow of Faerdhinen'),
  25867: bowOfFaerdhinen('Bow of Faerdhinen (c)'),
  25884: bowOfFaerdhinen('Bow of Faerdhinen (c), Ithell'),
  25886: bowOfFaerdhinen('Bow of Faerdhinen (c), Iorwerth'),
  25888: bowOfFaerdhinen('Bow of Faerdhinen (c), Trahaearn'),
  25890: bowOfFaerdhinen('Bow of Faerdhinen (c), Cadarn'),
  25892: bowOfFaerdhinen('Bow of Faerdhinen (c), Crwys'),
  25896: bowOfFaerdhinen('Bow of Faerdhinen (c), Amlodd'),
  6914: plainStaff('Master wand'),
  4675: plainStaff('Ancient staff'),
  // Infinite water runes: `spellRunes.ts`. Its 15% magic damage is a catalog stat.
  21006: plainStaff('Kodai wand'),
  // Its Ancient Magicks boost: `spellHitEffects.ts`, cited to the wiki there.
  27624: plainStaff('Ancient sceptre'),
  // /w/Nightmare_staff: no special and no passive; its 15% magic damage is a catalog stat.
  24422: plainStaff('Nightmare staff'),
  25736: {
    name: 'Holy scythe of vitur',
    // The swing and its blue sweep graphic; the captures name the weapon in
    // capture tob-hmt-5-packet-data-3.txt ("a Holy Scythe of Vitur").
    animation: [SOUND_AUDIT, COLOSSEUM_CAPTURE, 'capture:tob-hmt-5-packet-data-3.txt', WEAPON_SWEEP_CAPTURE],
    sound: [SOUND_AUDIT, WEAPON_SWEEP_CAPTURE],
    projectile: 'none',
    special: 'none',
  },
  22325: {
    name: 'Scythe of Vitur',
    // Its own swing sound is not captured. Accepted on the Holy scythe's recorded swing and sound,
    // which the variants share; only the sweep's color differs, and its red sweeps are captured
    // (capture tob-normal-mage-packet-data-1.txt, `MELEE_SWEEP_SPOTANIMS_BY_WEAPON`).
    animation: [SOUND_AUDIT, 'capture:tob-normal-mage-packet-data-1.txt', WEAPON_SWEEP_CAPTURE],
    sound: [SOUND_AUDIT, WEAPON_SWEEP_CAPTURE],
    projectile: 'none',
    special: 'none',
  },
  9185: {
    name: 'Rune crossbow',
    // 72/72 shots in the Zuk capture, on Rapid and Longrange. Accurate is not captured, but a ranged
    // style changes only speed and range, never the animation, sound or projectile.
    animation: [INFERNO_CAPTURE],
    sound: [INFERNO_CAPTURE],
    projectile: [INFERNO_CAPTURE],
    special: 'none',
  },
  31113: {
    name: 'Eye of Ayak',
    animation: [TOB_CAPTURE],
    sound: [SOUND_AUDIT, TOB_CAPTURE],
    projectile: [TOB_CAPTURE],
    // The only captured special splashed; its landing was accepted on review without a capture.
    special: [YAMA_FORFEIT_BREATH_CAPTURE, 'src/core/combat/player/specialAttacks/registry.ts'],
  },
  29594: {
    name: 'Purging staff',
    animation: 'spell',
    sound: 'spell',
    projectile: 'spell',
    // Never captured; accepted on review. Its demonbane boost: `ordinaryAttackModifiers.ts`.
    special: ['src/core/combat/player/specialAttacks/registry.ts'],
  },
  11806: {
    name: 'Saradomin godsword',
    animation: [WEAPON_SWEEP_CAPTURE],
    sound: [WEAPON_SWEEP_CAPTURE, SOUND_AUDIT],
    projectile: 'none',
    special: [WEAPON_SWEEP_CAPTURE, SOUND_AUDIT],
  },
  11802: {
    name: 'Armadyl godsword',
    animation: [WEAPON_SWEEP_CAPTURE],
    sound: [WEAPON_SWEEP_CAPTURE],
    projectile: 'none',
    special: [WEAPON_SWEEP_CAPTURE],
  },
  21003: {
    name: 'Elder maul',
    animation: [WEAPON_SWEEP_CAPTURE],
    sound: [WEAPON_SWEEP_CAPTURE],
    projectile: 'none',
    special: [SOUND_AUDIT],
  },
  29577: {
    name: 'Burning claws',
    animation: [WEAPON_SWEEP_CAPTURE],
    sound: [WEAPON_SWEEP_CAPTURE],
    projectile: 'none',
    special: [BURNING_CLAWS_SPECIAL_CAPTURE],
  },
  13652: {
    name: 'Dragon claws',
    animation: [WEAPON_SWEEP_CAPTURE, COLOSSEUM_CAPTURE],
    sound: [WEAPON_SWEEP_CAPTURE, COLOSSEUM_CAPTURE],
    projectile: 'none',
    special: [SOUND_AUDIT],
  },
  20997: {
    name: 'Twisted bow',
    // One Rapid shot with mithril arrows; the arrow's own launch and travel graphics come from the
    // ammunition, and a ranged style changes only speed and range.
    animation: [WEAPON_SWEEP_CAPTURE],
    sound: [WEAPON_SWEEP_CAPTURE],
    projectile: [WEAPON_SWEEP_CAPTURE],
    special: 'none',
  },
  22324: {
    name: 'Ghrazi rapier',
    animation: [WEAPON_SWEEP_CAPTURE, COLOSSEUM_CAPTURE],
    sound: [WEAPON_SWEEP_CAPTURE, COLOSSEUM_CAPTURE],
    projectile: 'none',
    special: 'none',
  },
  29589: {
    name: 'Emberlight',
    // Its demonbane bonus: `ordinaryAttackModifiers.ts`.
    animation: [WEAPON_SWEEP_CAPTURE, SOUND_AUDIT],
    sound: [WEAPON_SWEEP_CAPTURE, SOUND_AUDIT],
    projectile: 'none',
    special: [WEAPON_SWEEP_CAPTURE],
  },
  27679: {
    ...plainStaff('Accursed sceptre (a)'),
    // Condemn casts the powered sceptre's built-in spell: landed in the four Yama captures, splashed in the sweep.
    special: [WEAPON_SWEEP_CAPTURE, YAMA_FORFEIT_BREATH_CAPTURE],
  },
  // The ornament kit changes only the model.
  12006: abyssalTentacle('Abyssal tentacle'),
  26484: abyssalTentacle('Abyssal tentacle (or)'),
  27690: {
    name: 'Voidwaker',
    animation: [WEAPON_SWEEP_CAPTURE],
    sound: [WEAPON_SWEEP_CAPTURE, SOUND_AUDIT],
    projectile: 'none',
    special: [WEAPON_SWEEP_CAPTURE, SOUND_AUDIT],
  },
  29591: {
    name: 'Scorching bow',
    // Its ordinary shot is the loaded arrow's, like the Twisted bow's in the weapon sweep capture;
    // accepted on review. Its demonbane bonus: `ordinaryAttackModifiers.ts`.
    animation: [WEAPON_SWEEP_CAPTURE],
    sound: [SOUND_AUDIT],
    projectile: [WEAPON_SWEEP_CAPTURE, 'src/data/weaponCombatVisuals.ts'],
    special: SENSORY_CLOUDING_CAPTURES,
  },
  // Soul stacks: `soulreaper.ts`; Behead's 32 -> 41 splat in the capture fits it.
  28338: capturedMelee('Soulreaper axe', true),
  // The 15-85% passive and Eviscerate: `playerAttackProfileSelection.ts`.
  26219: capturedMelee("Osmumten's fang", true),
  13576: capturedMelee('Dragon warhammer', true),
  28810: capturedMelee('Zombie axe', false),
  11905: tridentOfTheSeas('Trident of the seas (full)'),
  11907: tridentOfTheSeas('Trident of the seas'),
  22288: tridentOfTheSeas('Trident of the seas (e)'),
  27275: {
    name: "Tumeken's shadow",
    animation: [SOUND_AUDIT],
    // The cast sound, and the impact sound at the target on every cast that lands.
    sound: [SOUND_AUDIT, COLOSSEUM_CAPTURE, YAMA_FORFEIT_BREATH_CAPTURE],
    projectile: [COLOSSEUM_CAPTURE, YAMA_FORFEIT_BREATH_CAPTURE, 'src/data/weaponCombatVisuals.ts'],
    special: 'none',
  },
  22978: {
    name: 'Dragon hunter lance',
    // Every style (stab/slash/crush) is captured in the weapon sweep; its +20% dragonbane
    // accuracy and damage modifier lives in `ordinaryAttackModifiers.ts`.
    animation: [WEAPON_SWEEP_CAPTURE],
    sound: [WEAPON_SWEEP_CAPTURE],
    projectile: 'none',
    special: 'none',
  },
};

export function findWeaponVerification(itemId: number): WeaponVerification | undefined {
  return VERIFIED_WEAPONS[itemId];
}

type Gaps = readonly [string, ...string[]];

const CHINCHOMPA_SOUNDS_UNMODELLED = 'Throw and explosion sounds not modeled.';
const CHINCHOMPA_GRAPHICS_UNVERIFIED = 'Projectile graphic unverified.';

/**
 * Explicitly accepted limitations, not evidence of full implementation. Acceptance applies only to
 * the exact item id and never bypasses capability checks or extends to cosmetic variants.
 * These weapons belong in neither the fully verified evidence list nor the blocking gap list.
 */
export const WEAPON_VERIFICATION_LIMITATIONS: Readonly<Record<number, Gaps>> = {
  // Eclipse atlatl: accepted with its rarely used special still unsupported.
  29000: ['Special attack unavailable.'],
  // Volatile and Eldritch Nightmare staves: ordinary autocasting staves (/w/Nightmare_staff), accepted
  // without Immolate and Invocate (/w/Volatile_Nightmare_staff, /w/Eldritch_Nightmare_staff), which
  // are left out of the special attack registry like the atlatl's.
  24424: ['Special attack unavailable.'],
  24425: ['Special attack unavailable.'],
  // Venator bow: shot, sounds and ricochet from the three Colosseum wave captures (124 shots), rules
  // from /w/Venator_bow; `src/core/combat/player/ricochet.ts`. Accepted without these.
  27610: [
    'Charges not tracked; always charged.',
    'Ricochet target choice approximated.',
    'Ricochet Salve and flat armour exceptions not modeled.',
  ],
  // Every style in SOULREAPER_FANG_TRIDENTS_CAPTURE (ticks 596-607). Its special refused there,
  // "You can only use this special attack whilst you are poisoned.", and player poison is not
  // simulated, so it is left out of the special attack registry.
  29796: ['Special attack needs poison; not simulated.', 'Venom passive not simulated.'],
  // Every style in SOULREAPER_FANG_TRIDENTS_CAPTURE (ticks 624-632); NPCs cannot be envenomed here.
  12899: ['Venom not simulated.'],
  // The (e) version differs only in charge capacity (OSRS Wiki, Trident of the swamp (e)).
  22292: ['Venom not simulated.'],
  // Chinchompas: docs/research/chinchompas.md marks each fuse, area and accuracy rule as cited,
  // simulator policy or simulator choice. The black
  // throw's animation, projectile, impact and timing are captured
  // (capture inferno-waves-(35ish)-to-68-packet-data.txt L4665-4686, L4806-4822); its throw and
  // explosion sounds there are not modeled, so it plays the generic ranged sound.
  11959: [CHINCHOMPA_SOUNDS_UNMODELLED],
  // Never captured: grenades named by RuneLite gameval (`chinchompaVisuals`), the rest assumed black's.
  10033: [CHINCHOMPA_GRAPHICS_UNVERIFIED, CHINCHOMPA_SOUNDS_UNMODELLED],
  10034: [CHINCHOMPA_GRAPHICS_UNVERIFIED, CHINCHOMPA_SOUNDS_UNMODELLED],
};

const SPECIAL_NOT_IMPLEMENTED = 'Special attack not implemented.';
const NORMAL_ATTACKS_UNVERIFIED = 'Normal attacks unverified.';
const SPECIAL_GRAPHICS_MISSING = 'Special attack graphics missing.';
const DRAGON_BONUS_NOT_IMPLEMENTED = 'Dragon damage bonus not implemented.';
const SWING_SOUND_UNVERIFIED = 'Swing sound unverified.';
const ARROW_GRAPHICS_UNVERIFIED = 'Arrow graphics unverified.';

/**
 * Weapons we checked and found short of verified: what is unverified or missing, one short
 * player-facing line each, shown on the unverified item's hover card. A weapon listed here must not
 * also be in {@link VERIFIED_WEAPONS} or {@link WEAPON_VERIFICATION_LIMITATIONS}; fixing its last
 * gap means moving it to the evidence list, while accepting a limitation means moving it, with its
 * gaps, to {@link WEAPON_VERIFICATION_LIMITATIONS}.
 * Keyed by exact item id. A weapon in none of these lists has not been checked.
 */
export const WEAPON_VERIFICATION_GAPS: Readonly<Record<number, Gaps>> = {
  // No capture carries this variant's swing sound.
  25739: [SWING_SOUND_UNVERIFIED],
  // The whip's normal attacks were never captured; the tentacle's (which share the whip's
  // animation and, per the wiki, its sounds) were.
  4151: [NORMAL_ATTACKS_UNVERIFIED],
  // Every captured mace swing is Pummel (the three Glyphic captures); the crush styles share its
  // swing and sound, but Spike's stab has never been recorded.
  24417: ['Spike attacks unverified.'],
  // Shove could not be captured: it refuses large targets ("That creature is too large to knockback!").
  11824: [SPECIAL_NOT_IMPLEMENTED],
  11889: [SPECIAL_NOT_IMPLEMENTED],
  // Rock Knocker boosts Mining rather than attacking.
  11920: [SPECIAL_NOT_IMPLEMENTED],
  // One capture of the special (weapon sweep capture, tick 1024) cannot give its projectile's flight.
  11785: [SPECIAL_NOT_IMPLEMENTED],
  // The cache names no spotanims of their own, so these draw the plain (c) bow's.
  25894: [ARROW_GRAPHICS_UNVERIFIED],
  33021: [ARROW_GRAPHICS_UNVERIFIED],
  // Every captured cast of its own attack splashed (weapon sweep capture, ticks 517-529).
  27665: ['Landed attacks unverified.'],
  27662: [SPECIAL_NOT_IMPLEMENTED],
  // Power of Death works, but its activation animation and graphic are unknown.
  22296: [SPECIAL_GRAPHICS_MISSING],
  11791: [SPECIAL_GRAPHICS_MISSING],
  // The freeze's ice graphic on the target (weapon sweep capture, tick 987) needs a hit-only graphic.
  11808: ['Special attack freeze graphic missing.'],
  // Sever is simulated from the wiki; its animation and sounds were never captured.
  4587: ['Special attack unverified.'],
  // Dragon hunter wand spell dragonbane passive is not modeled yet.
  30070: [DRAGON_BONUS_NOT_IMPLEMENTED],
};
