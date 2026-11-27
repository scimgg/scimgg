import { chebyshevDistanceToRect } from '../core/combat/distance';
import { calculateProjectileEndTime, PROJ_ANIM_TIMINGS, type ProjAnimTiming } from '../core/combat/hitDelay';
import { getProjectileTiming } from '../core/combat/weaponCombatData';
import { type AttackKind, type GameEvent, isCoreEvent, type SpellCastSnapshot } from '../core/events/types';
import { getEquipmentAliasIds } from '../data/equipmentCatalog';
import { getEquipmentCombatBaseId } from '../data/equipmentCombatFamilies';
import { SpotAnimID } from '../rs/config/spotanimtype/SpotAnimID';
import { findWeaponCategoryKey } from '../types/attackStyles';
import { PrayerType } from '../types/simulation';
import { coordinateFrom, play, type SoundRule, type SoundRuleValue, silent } from './EventAudioPlayer';

/**
 * Universal combat / UI sound rules — shared by all encounters.
 *
 * Where a sound id could be re-derived it comes from private gameplay captures (cited by file name; not
 * distributed here) or
 * from rsmod, which override the RuneLite tables wherever the two disagree:
 * docs/architecture/audio-sound-ids.md. That pass did not settle every id — stab 2517, crush
 * 2567 and the elemental casts 160/220/211 are recorded there as unverifiable and were left as
 * they were, so treat those as unsourced rather than capture-backed.
 *
 * Third-party lookups still list superseded ids (bow 2693, 510 for damage taken); captures win, so do
 * not "restore" a value from them (docs/architecture/audio-sound-ids.md section 7).
 */

// Generic weapon-type swing sounds.
const MELEE_SLASH = 2500; // Scimitar slash (generic slash representative)
const MELEE_STAB = 2517; // Dagger stab
const MELEE_CRUSH = 2567; // Maul crush
/**
 * Weapons whose swing has its own sound instead of the generic style sound above. Each
 * fires on 100% of that weapon's attack-animation ticks and plays nowhere else, so
 * folding one back into MELEE_SLASH/STAB/CRUSH is always a regression.
 *
 * Only the style the capture happens to use is proven (the godsword's is `slash`), so these
 * apply to all styles. A weapon shown to vary by style belongs in `STYLE_ATTACK_SOUNDS` instead.
 */
const INQUISITORS_MACE_ATTACK = 2508; // 251/251 attack ticks, glyphic captures
const SCYTHE_OF_VITUR_ATTACK = 2524; // 501/501, colosseum + vardorvis + duke captures
const GODSWORD_ATTACK = 3847; // 10/10 `dh_sword_update_slash` ticks, yama captures
/**
 * The weapon sweep capture, cited by tick below:
 * capture weapon-attacks-sgs-elder-maul-burning-claws-tbow-emberlight-accursed-sceptre-ghrazi-rapier-dragon-claws-scythe-bowfa-whip-tentacle-dhl-zspear-hasta-dscim-ags-zgs-voidwaker-dragon-pickaxe-packet-data.txt
 */
// Smash (`dh_sword_update_smash`) on the Saradomin, Armadyl and Zamorak godswords: ticks 370, 876, 981.
const GODSWORD_SMASH = 3846;
const ELDER_MAUL_ATTACK = 3454; // Every style: ticks 383-407.
// Every style of the tentacle (662-674); /w/Abyssal_whip and /w/Abyssal_tentacle list the same file.
const WHIP_ATTACK = 2720;

// 2700 is what every `human_bow` tick plays across the colosseum (n=119) and Leviathan
// (n=82) captures; the widely-copied 2693 appears in no capture at all, so do not
// "restore" it.
const RANGE_BOW = 2700;
// Every crossbow shot: 72/72 `xbows_human_fire_and_reload_pvn` ticks in
// capture inferno-waves-69-zuk-packet-data.txt and 2/2 `zcb_attack_pvn` ticks in
// capture tob-normal-mage-packet-data-1.txt. Crossbows attack as `range_arrow`, so this keys
// off the weapon category rather than the attack kind.
const RANGE_CROSSBOW = 2695;
const ECLIPSE_ATLATL_ATTACK = 2699; // 2384/2384, inferno captures
const TOXIC_BLOWPIPE_ATTACK = 2696; // 27/27, inferno captures
// capture blowpipe-spec-bowfa-attacks-packet-data.txt:28-29,75; delay is client cycles.
const TOXIC_BLOWPIPE_SPEC_SOUND = 800;
const BOWFA_ATTACK = 1352;
/**
 * Venator bow, all three on the launch tick of the three Colosseum wave captures' Venator shots: the
 * shot on 124/124, the first ricochet's on 105/105 shots that bounced, the second's on 85/85 that
 * bounced twice (/w/Venator_bow § Sound effects: attack, ricochet 1, ricochet 2).
 */
const VENATOR_BOW_ATTACK = 6797;
const VENATOR_BOW_RICOCHETS = [6672, 6735] as const;
const TOXIC_BLOWPIPE_SPEC = [TOXIC_BLOWPIPE_ATTACK, { id: TOXIC_BLOWPIPE_SPEC_SOUND, delayCycles: 32 }];

const MAGIC_FIRE = 160; // Fire Strike/Bolt/Blast/Wave cast
const MAGIC_AIR = 220; // Wind Strike/Bolt/Blast/Wave cast
const MAGIC_WATER = 211; // Water Strike/Bolt/Blast/Wave cast
const MAGIC_SHADOW = 178; // Shadow Rush/Blitz/Barrage cast (Ancient Magicks)
const MAGIC_SPLASH = 227; // Spell splash / fail (RuneLite MAGIC_SPLASH_BOING)
/** Every splash in the captures is `sound_area ... range=10`; the 15-tile default is too generous. */
const MAGIC_SPLASH_RANGE = 10;

/**
 * rsmod's `StandardPlayerHitProcessor.resolveDefendSound` is the authority and the captures agree
 * with it exactly — see docs/architecture/audio-sound-ids.md.
 *
 * ONE sound per hitsplat on the LOCAL PLAYER, and none at all for a hitsplat on an NPC, so
 * this must stay gated on the target: firing it for every `hit_applied` machine-guns the
 * splat sound for the whole time you are hitting a boss.
 *
 * Damage taken picks uniformly from the body type's set. Ours is fixed: `PlayerModelLoader`
 * defaults `gender: 0`, which is body type A — body type B is the two-sound set 509/510, and
 * swapping the avatar to it would need this to follow.
 *
 * A 0 splat instead resolves the block sound off the DEFENDER'S GEAR: the left hand's
 * `item_block_sound1..5`, else the torso's, else `human_block_1`. Those params live in
 * rsmod's own 65417-65421 range, not in any cache we ship (verified against both the 232 and
 * 2485 caches), and no capture records what was worn — so the per-item sets are simply not
 * derivable here and every loadout falls through to `human_block_1`. Six armour sets DO show
 * up across the captures (2841-2845, 2811-2815, 2963-2967, 2766-2770, 2772/2777-2780, and a
 * shield's 30/1345/1349/1350/2968); do not promote one to a default without the per-item data
 * behind it.
 */
const PLAYER_DAMAGE_SOUNDS = [518, 519, 520, 521]; // human_hit_1..4
const PLAYER_BLOCK_SOUND = 511; // human_block_1
/** rsmod plays the defend sound at exactly this delay, and every capture agrees. */
const HITSPLAT_DELAY_CYCLES = 20;
const PLAYER_ACTOR_ID = 'player';

function pickVariant(sounds: readonly number[]): number {
  return sounds[Math.floor(Math.random() * sounds.length)];
}

// RuneLite SoundEffectID.java
// Rigour/Augury share sounds with Sharp Eye/Mystic Will.
const PRAYER_ACTIVATION_SOUNDS: Record<string, number> = {
  [PrayerType.ProtectMagic]: 2675, // PRAYER_ACTIVATE_PROTECT_FROM_MAGIC
  [PrayerType.ProtectRange]: 2677, // PRAYER_ACTIVATE_PROTECT_FROM_MISSILES
  [PrayerType.ProtectMelee]: 2676, // PRAYER_ACTIVATE_PROTECT_FROM_MELEE
  [PrayerType.EagleEye]: 2665,
  [PrayerType.MysticMight]: 2669,
  [PrayerType.Piety]: 3825, // PRAYER_ACTIVATE_PIETY
  [PrayerType.Zeal]: 12645, // Sound id per OSRS Wiki File:Zeal.ogg
  [PrayerType.Rigour]: 2685, // PRAYER_ACTIVATE_SHARP_EYE_RIGOUR
  [PrayerType.Augury]: 2670, // PRAYER_ACTIVATE_MYSTIC_WILL_AUGURY
  [PrayerType.Deadeye]: 10194,
  [PrayerType.MysticVigour]: 10100,
  [PrayerType.Redemption]: 2680, // PRAYER_ACTIVATE_REDEMPTION
  [PrayerType.Preserve]: 2679, // PRAYER_ACTIVATE_RAPID_RESTORE_PRESERVE — shared with Rapid Restore
  [PrayerType.RapidRestore]: 2679,
  [PrayerType.RapidHeal]: 2678, // PRAYER_ACTIVATE_RAPID_HEAL
  // The tiered prayers and Chivalry, from SoundEffectID.java at runelite/runelite@e3d1667.
  [PrayerType.ThickSkin]: 2690, // PRAYER_ACTIVATE_THICK_SKIN
  [PrayerType.BurstOfStrength]: 2688, // PRAYER_ACTIVATE_BURST_OF_STRENGTH
  [PrayerType.ClarityOfThought]: 2664, // PRAYER_ACTIVATE_CLARITY_OF_THOUGHT
  [PrayerType.SharpEye]: 2685, // PRAYER_ACTIVATE_SHARP_EYE_RIGOUR
  [PrayerType.MysticWill]: 2670, // PRAYER_ACTIVATE_MYSTIC_WILL_AUGURY
  [PrayerType.RockSkin]: 2684, // PRAYER_ACTIVATE_ROCK_SKIN
  [PrayerType.SuperhumanStrength]: 2689, // PRAYER_ACTIVATE_SUPERHUMAN_STRENGTH
  [PrayerType.ImprovedReflexes]: 2662, // PRAYER_ACTIVATE_IMPROVED_REFLEXES
  [PrayerType.HawkEye]: 2666, // PRAYER_ACTIVATE_HAWK_EYE
  [PrayerType.MysticLore]: 2668, // PRAYER_ACTIVATE_MYSTIC_LORE
  [PrayerType.SteelSkin]: 2687, // PRAYER_ACTIVATE_STEEL_SKIN
  [PrayerType.UltimateStrength]: 2691, // PRAYER_ACTIVATE_ULTIMATE_STRENGTH
  [PrayerType.IncredibleReflexes]: 2667, // PRAYER_ACTIVATE_INCREDIBLE_REFLEXES
  [PrayerType.Chivalry]: 3826, // PRAYER_ACTIVATE_CHIVALRY
};
const PRAYER_DEACTIVATE = 2663; // PRAYER_DEACTIVE_VWOOP
const PRAYER_DEPLETE_TWINKLE = 2672; // PRAYER_DEPLETE_TWINKLE — drained to 0 or activation rejected

// Confirmed across all sources.
const EAT_FOOD = 2393;
const DRINK_POTION = 2401;
// A surge potion drink adds 6182 to the ordinary drink sound (weapon sweep capture, ticks 541 and 1036).
const SURGE_POTION_DRINK = 6182;
const SURGE_POTION_IDS: ReadonlySet<number> = new Set([30875, 30878, 30881, 30884]);

const EQUIP_FUN = 2238;
const EQUIP_METAL_BODY = 2239;
const EQUIP_HELMET = 2240;
const EQUIP_LEGS = 2242;
const EQUIP_HANDS = 2236;
const EQUIP_STAFF = 2247;

// human_death
const PLAYER_DEATH = 512;

const MARK_OF_DARKNESS_CAST = [5046, 5015];
const MARK_OF_DARKNESS_FADED = 5000;

/**
 * Death Charge shares Mark of Darkness's self-imbue animation (8970), so the two casts are told
 * apart by spotanim. Every capture cast is the upgraded spotanim (3288); the base one is assumed to
 * share the sound. capture colosseum-no-sol-packet-data.txt, by tick:
 */
const DEATH_CHARGE_CAST = 5034; // 1478: the only sound beside spotanim 3288 + seq 8970.
const DEATH_CHARGE_PROC = 5047; // 1543, 1546: once per kill that pays out, with the +150 sa_energy.
const DEATH_CHARGE_FADED = 5056; // 2257: window ran out with a proc unspent, "has faded away".
const DEATH_CHARGE_CAST_SPOTANIMS: ReadonlySet<unknown> = new Set([
  SpotAnimID.VFX_PLAYER_DEATH_CHARGE,
  SpotAnimID.VFX_PLAYER_DEATH_CHARGE_UPGRADE,
]);

// obj_del of the taken item + this synth on the same tick: tob-normal-mage-packet-data-1.txt ticks 542, 2092, 2174.
const ITEM_PICKUP = 2582;

const SATURATED_HEART_ACTIVATED = 6847;
const SATURATED_HEART_FADED = 228;
const SATURATED_HEART_SPOTANIM = 2287;

// /w/Redemption?oldid=15148542 lists 2681 as the sound the proc plays.
const REDEMPTION_HEAL = 2681;

// Purging staff "Scatter ashes" kill: bare `synth_sound 9315, delay=5` on the killing-blow tick,
// 462/462 alongside the killed npc's `vfx_ignite_staff_01_2x2` across every capture
// (capture yama_divine_severance.txt tick 3214). Keyed on the graphic, which the sim emits
// for exactly that kill; the 1x1/3x3 variants are the same effect on other footprints.
const SCATTER_ASHES_KILL = { id: 9315, delayCycles: 5 } as const;
const SCATTER_ASHES_SPOTANIMS: ReadonlySet<unknown> = new Set([
  SpotAnimID.VFX_IGNITE_STAFF_01_1X1,
  SpotAnimID.VFX_IGNITE_STAFF_01_2X2,
  SpotAnimID.VFX_IGNITE_STAFF_01_3X3,
]);

const DARK_DEMONBANE_CAST = [5053, 5035] as const;

// capture ancient-spells-casts-anims-sounds-packet-data.txt:48-49,124-127,191-192,262-265,
// 337-338,402-405,482-483,551-554,616-618,691-695,766-772,846-848,928-930,1010-1011,1077-1080,1136-1139
const ANCIENT_SPELL_SOUNDS: Readonly<Record<string, readonly [number, number]>> = {
  'Smoke Rush': [183, 185],
  'Shadow Rush': [178, 179],
  'Blood Rush': [106, 110],
  'Ice Rush': [171, 173],
  'Smoke Burst': [183, 182],
  'Shadow Burst': [178, 177],
  'Blood Burst': [106, 105],
  'Ice Burst': [171, 170],
  'Smoke Blitz': [183, 181],
  'Shadow Blitz': [178, 176],
  'Blood Blitz': [106, 104],
  'Ice Blitz': [171, 169],
  'Smoke Barrage': [183, 180],
  'Shadow Barrage': [178, 175],
  'Blood Barrage': [106, 102],
  'Ice Barrage': [171, 168],
};

const ACCURSED_SCEPTRE_CAST = MAGIC_SHADOW;
/**
 * Condemn: 183 on the swing, then 163 when its projectile arrives (`endtime = 46 + 10 * distance`), on
 * every captured special whether it landed (the four Yama captures) or splashed (weapon sweep capture,
 * tick 545, where 227 plays beside it).
 */
const ACCURSED_SCEPTRE_SPEC = [183, 163] as const;

const TUMEKENS_SHADOW_CAST = 6410;
/**
 * `sound_area 1460, range=10` at the target on every cast that lands, delayed to the projectile's
 * `endtime`; a splash plays 227 there instead. 55/55 landed casts across
 * capture colosseum-no-sol-packet-data.txt:370 and capture yama_forfeit_breath.txt:287.
 */
const TUMEKENS_SHADOW_IMPACT = 1460;

/**
 * Cast 178, then `sound_area 1460, range=10` at the target at the projectile's `endtime` when it lands:
 * 215/215 `human_eye_of_ayak_normal` ticks across the ToB captures.
 */
const EYE_OF_AYAK_CAST = [MAGIC_SHADOW, 1460] as const;
const EYE_OF_AYAK_SPEC = [
  { id: 10313, delayCycles: 21 },
  { id: 10322, delayCycles: 81 },
  { id: 10319, delayCycles: 108 },
  { id: 10311, delayCycles: 122 },
  { id: 10329 },
  { id: 10330 },
  { id: 10325 },
  { id: 10318 },
  { id: 10327 },
  { id: 10326 },
];

/**
 * A weapon's ids: the ones named here plus every generated cosmetic, locked or degraded alias, so
 * an ornate godsword or a Trailblazer blowpipe still
 * finds its swing sound instead of falling through to the generic style sound.
 */
function weaponFamily(...baseIds: readonly number[]): ReadonlySet<number> {
  const ids = new Set(baseIds);
  for (const baseId of baseIds) {
    for (const variantId of getEquipmentAliasIds(baseId)) ids.add(variantId);
  }
  return ids;
}

const ACCURSED_SCEPTRE_WEAPONS = weaponFamily(27662, 27665);
const ACCURSED_SCEPTRE_A_WEAPONS = weaponFamily(27676, 27679);
const EYE_OF_AYAK_WEAPONS = weaponFamily(31115, 31113);
const TUMEKENS_SHADOW_WEAPONS = weaponFamily(27275);
const INQUISITORS_MACE_WEAPONS = weaponFamily(24417);
const SCYTHE_OF_VITUR_WEAPONS = weaponFamily(22325, 22486, 25736, 25738, 25739, 25740, 25741, 25742);
const GODSWORD_WEAPONS = weaponFamily(11802, 11804, 11806, 11808, 20368, 20370, 20372, 20374, 20593, 26233);
const TOXIC_BLOWPIPE_WEAPONS = weaponFamily(12926);
// The crystal bow plays the Bowfa's 1352 on the launch tick: an in-game observation,
// docs/research/crystal-bow.md.
const BOWFA_SOUND_WEAPONS = weaponFamily(25865, 25867, 23983);
const VENATOR_BOW_WEAPONS = weaponFamily(27610);

/**
 * Special attacks that emit their own sound stack, overriding the weapon's normal swing. A spec
 * missing from this table falls through to that swing rather than going silent, which is what OSRS
 * does for every spec whose animation carries no sound of its own.
 *
 * The capture sends all of these as `sound_area` at the PLAYER's own tile except the
 * Voidwaker and elder maul pair, which are bare synths — the listener is the player either
 * way, so they all resolve to full volume and none of them takes a position here.
 */
const DRAGON_CLAWS_SPEC = [
  { id: 4138, delayCycles: 10 },
  { id: 4140, delayCycles: 30 },
  { id: 4141, delayCycles: 42 },
  { id: 4141, delayCycles: 60 },
];
// The same `sound_area 3869` for the Saradomin (376), Armadyl (892) and Zamorak (987) godswords.
const GODSWORD_SPEC = 3869;
const WHIP_SPEC = 2713; // Tentacle special, tick 678; the wiki gives the whip the same file.
// Emberlight's Weaken, tick 497.
const EMBERLIGHT_SPEC = [
  { id: 9319, delayCycles: 11 },
  { id: 9320, delayCycles: 28 },
  { id: 9321, delayCycles: 53 },
];
// Armadyl crossbow special, tick 1024: the bolt sound is replaced by this one.
const ARMADYL_CROSSBOW_SPEC = { id: 3892, delayCycles: 15 };
const VOIDWAKER_SPEC_CAST = 5027;
const VOIDWAKER_SPEC_IMPACT = 6182;
const VOIDWAKER_SPEC = [VOIDWAKER_SPEC_CAST, { id: VOIDWAKER_SPEC_IMPACT, delayCycles: 30 }];
const ELDER_MAUL_SPEC = { id: 8984, delayCycles: 2 };
// capture abyssal-bludgeon-special-attack-packet-data.txt:18-19
const ABYSSAL_BLUDGEON_SPEC = [
  { id: 2715, delayCycles: 10 },
  { id: 1930, delayCycles: 30 },
];

/**
 * Both claws play `dragonclaws_normal` on every style, so this is a weapon-only mapping rather than
 * a `STYLE_ATTACK_SOUNDS` row (/w/Burning_claws § Sound effects): 25/25 Slash swings across the
 * colosseum and ToB captures, and every style of both claws in the weapon sweep capture (440-452, 601-609).
 */
const CLAWS_ATTACK = 4139;
/**
 * `burning_claws_swipe_01` twice per spec, and NEITHER play is on the swing tick:
 * capture burning-claws-special-attack-packet-data.txt:66-67 sends both as
 * `synth_sound id=9316` at delay=29 and delay=60. Starting the first at 0 to "match the swing"
 * pulls it a whole tick early, and collapsing the pair into one loses an audible play.
 */
const BURNING_CLAWS_SPEC_SOUND = 9316;
const BURNING_CLAWS_SPEC = [
  { id: BURNING_CLAWS_SPEC_SOUND, delayCycles: 29 },
  { id: BURNING_CLAWS_SPEC_SOUND, delayCycles: 60 },
];

/**
 * Scorching bow spec: the bow shot plus 9327 and 9328 at launch, then 9325 and 9326 as synths at the
 * projectile's `endtime`, hit or miss, on 10/10 specs in capture yama-contract-of-sensory-clouding-*.txt
 * (e.g. yama-contract-of-sensory-clouding-packet-data-1(incomplete).txt:17214-17216).
 */
const SCORCHING_BOW_LAUNCH = [RANGE_BOW, { id: 9327, delayCycles: 11 }, { id: 9328, delayCycles: 46 }];
const SCORCHING_BOW_IMPACT = [9325, 9326] as const;

/**
 * capture weapon-soulreaper-fang-dragonwarhammer-zombieaxe-noxhalberd-tridentoftheswamps-tridentoftheseas-packet-data.txt,
 * cited by tick below and in `STYLE_ATTACK_SOUNDS`.
 */
const SOULREAPER_AXE_SPEC = 7019; // Behead, tick 473.
const DRAGON_WARHAMMER_SPEC = 2520; // Smash, tick 551.
/**
 * The tridents cast with 178 and, on a cast that lands, `sound_area 1460, range=10` at the target at
 * the projectile's `endtime` (delay 56 at one tile): all six casts, ticks 624-651, on every style.
 */
const TRIDENT_CAST = MAGIC_SHADOW;
const TRIDENT_IMPACT = 1460;

const SOULREAPER_AXE_WEAPONS = weaponFamily(28338);
const DRAGON_WARHAMMER_WEAPONS = weaponFamily(13576);
/**
 * Eviscerate's server sends no sound on its tick (522), so no rule may play one: its swipes are the
 * client's own frame sounds on the player graphic's sequence (spotanim 2833 -> seq 11239: 9367,
 * 9366, 9365), which `FrameSoundTracker` plays. Falling through to the fang's swing would add 2549.
 */
const SILENT_SPEC_WEAPONS = weaponFamily(26219);
const TRIDENT_WEAPONS = weaponFamily(11905, 11907, 22288, 12899, 22292);
const DRAGON_CLAWS_WEAPONS = weaponFamily(13652, 20784);
const SPEC_SOUND_GODSWORD_WEAPONS = weaponFamily(11802, 20368, 11806, 20372, 11808, 20374);
const WHIP_WEAPONS = weaponFamily(4151, 12773, 12774, 26482, 12006, 26484);
const EMBERLIGHT_WEAPONS = weaponFamily(29589);
const ARMADYL_CROSSBOW_WEAPONS = weaponFamily(11785);
// RuneLite gameval ItemID.VOIDWAKER; 27655 is the charged Webweaver bow, not a Voidwaker.
const VOIDWAKER_WEAPONS = weaponFamily(27690);
const ELDER_MAUL_WEAPONS = weaponFamily(21003, 27100);
const ABYSSAL_BLUDGEON_WEAPONS = weaponFamily(13263);
const BURNING_CLAWS_WEAPONS = weaponFamily(29577);
const SCORCHING_BOW_ID = 29591;
const SCORCHING_BOW_WEAPONS = weaponFamily(SCORCHING_BOW_ID);

/**
 * Hasta sounds vary by attack kind; a weapon-only mapping mis-sounds two styles.
 * capture weapon-attacks-zamorakian-hasta-abyssal-bludgeon-sarachnis-cudgel-packet-data.txt:34-142,202-280,320-423
 */
const SLASH_SWORD_STYLE_SOUNDS: Partial<Record<AttackKind, number>> = { melee_stab: 2501 };

const STYLE_ATTACK_SOUNDS: Record<number, Partial<Record<AttackKind, number>>> = {
  11889: { melee_stab: 2562, melee_slash: 2524, melee_crush: 2555 },
  23528: { melee_crush: 2508, melee_stab: 2509 },
  13263: { melee_crush: 1309 },
  // Ghrazi rapier: 2549 on 12/12 Lunge swings (colosseum capture) and the sweep capture's Stab (573);
  // Slash plays its own 2548 (565, 569).
  22324: { melee_stab: 2549, melee_slash: 2548 },
  // The rest are the weapon sweep capture's, by tick.
  // Scythes: Jab (635), on the Holy scythe; its other styles keep SCYTHE_OF_VITUR_ATTACK.
  22325: { melee_crush: 2522 },
  // Slash swords: Lunge on the Dragon scimitar (842), Emberlight (483) and Voidwaker (1049).
  4587: SLASH_SWORD_STYLE_SOUNDS,
  29589: SLASH_SWORD_STYLE_SOUNDS,
  27690: SLASH_SWORD_STYLE_SOUNDS,
  22978: { melee_stab: 2562, melee_slash: 2524, melee_crush: 2555 }, // Dragon hunter lance, 703-715
  11824: { melee_stab: 2562, melee_slash: 2556, melee_crush: 2555 }, // Zamorakian spear, 726-738
  11920: { melee_stab: 2498, melee_crush: 2497 }, // Dragon pickaxe, 1074-1089
  // The soulreaper/fang/warhammer/axe/halberd/trident capture's, by tick.
  28338: { melee_slash: 1321, melee_crush: 1316 }, // Soulreaper axe, 440-467
  26219: { melee_stab: 2549, melee_slash: 2548 }, // Osmumten's fang, 497-517
  13576: { melee_crush: 2567 }, // Dragon warhammer, 532-545: confirms the generic crush sound
  28810: { melee_slash: 2498, melee_crush: 2497 }, // Zombie axe, 560-577
  29796: { melee_stab: 2562, melee_slash: 2524 }, // Noxious halberd, 596-607
};

function resolveStyleAttackSound(weaponId: number, attackKind: AttackKind): number | undefined {
  return STYLE_ATTACK_SOUNDS[weaponId]?.[attackKind];
}

const CLIENT_CYCLES_PER_TICK = 30;

const ATTACK_KIND_SOUNDS: Partial<Record<AttackKind, number>> = {
  melee_slash: MELEE_SLASH,
  melee_stab: MELEE_STAB,
  melee_crush: MELEE_CRUSH,
  range_arrow: RANGE_BOW,
  magic_fire: MAGIC_FIRE,
  magic_shadow: MAGIC_SHADOW,
  magic_air: MAGIC_AIR,
  magic_water: MAGIC_WATER,
};

const EQUIP_SOUND_BY_KIND: Record<string, number> = {
  fun: EQUIP_FUN,
  metal_body: EQUIP_METAL_BODY,
  helmet: EQUIP_HELMET,
  legs: EQUIP_LEGS,
  hands: EQUIP_HANDS,
  staff: EQUIP_STAFF,
};

/**
 * Weapons whose wield sound the slot/category kind above gets wrong, keyed by combat base id. The
 * soulreaper/fang/warhammer capture wields each once: the Soulreaper axe (tick 434) and Zombie axe
 * (556) play 2232, the Dragon warhammer 2233 (527), and the Noxious halberd the staff's 2247 (582).
 * The fang (2238) and the tridents (2247) already resolve correctly by kind.
 */
const WEAPON_EQUIP_SOUNDS: Readonly<Record<number, number>> = {
  28338: 2232,
  28810: 2232,
  13576: 2233,
  29796: EQUIP_STAFF,
};

function resolveProjectileLayeredAttack(event: GameEvent, castSoundId: number, impactSoundId: number): SoundRuleValue {
  const ticks = (event as Record<string, unknown>).impactDelayTicks;
  const impactDelayTicks = typeof ticks === 'number' && ticks > 0 ? ticks : 0;
  if (impactDelayTicks <= 0) {
    return [castSoundId, impactSoundId];
  }
  return [
    castSoundId,
    {
      id: impactSoundId,
      delayCycles: impactDelayTicks * CLIENT_CYCLES_PER_TICK,
    },
  ];
}

/** Without a launch snapshot the arrival cannot be timed, so only the launch sounds play. */
function scorchingBowSpecSounds(event: Extract<GameEvent, { type: 'attack_started' }>): SoundRuleValue {
  const cast = event.spellCast;
  const timing = getProjectileTiming(SCORCHING_BOW_ID, true);
  if (!cast || !timing) return SCORCHING_BOW_LAUNCH;
  const delayCycles = calculateProjectileEndTime(
    timing,
    chebyshevDistanceToRect(
      cast.sourcePosition[0],
      cast.sourcePosition[1],
      cast.targetPosition[0],
      cast.targetPosition[1],
      cast.targetSize,
    ),
  );
  return [...SCORCHING_BOW_LAUNCH, ...SCORCHING_BOW_IMPACT.map((id) => ({ id, delayCycles }))];
}

/** Condemn's arrival sound plays on a splash too, so unlike a spell's impact it ignores accuracy. */
function condemnSounds(event: Extract<GameEvent, { type: 'attack_started' }>): SoundRuleValue {
  const cast = event.spellCast;
  const timing = event.weaponId === undefined ? undefined : getProjectileTiming(event.weaponId, true);
  if (!cast || !timing)
    return resolveProjectileLayeredAttack(event, ACCURSED_SCEPTRE_SPEC[0], ACCURSED_SCEPTRE_SPEC[1]);
  const distance = chebyshevDistanceToRect(
    cast.sourcePosition[0],
    cast.sourcePosition[1],
    cast.targetPosition[0],
    cast.targetPosition[1],
    cast.targetSize,
  );
  return [
    ACCURSED_SCEPTRE_SPEC[0],
    { id: ACCURSED_SCEPTRE_SPEC[1], delayCycles: calculateProjectileEndTime(timing, distance) },
  ];
}

/**
 * A cast sound, plus its impact as a `sound_area` on the target's tile when the cast lands, delayed to
 * the moment its projectile arrives. A cast without a snapshot, or one that splashes, plays the cast
 * alone: the splash has its own sound on `hit_applied`.
 */
function castWithTargetImpact(
  castSound: number,
  impactSound: number,
  cast: SpellCastSnapshot | undefined,
  timing: ProjAnimTiming,
): SoundRuleValue {
  if (cast?.accurate !== true) return castSound;
  const distance = chebyshevDistanceToRect(
    cast.sourcePosition[0],
    cast.sourcePosition[1],
    cast.targetPosition[0],
    cast.targetPosition[1],
    cast.targetSize,
  );
  return [
    castSound,
    {
      id: impactSound,
      position: cast.targetPosition,
      range: 10,
      delayCycles: calculateProjectileEndTime(timing, distance),
    },
  ];
}

function resolvePlayerAttackSound(event: GameEvent): SoundRuleValue | null {
  if (!isCoreEvent(event, 'attack_started') || event.sourceId !== PLAYER_ACTOR_ID) return null;

  const spellId = event.spellId;
  const ancientSounds = spellId === undefined ? undefined : ANCIENT_SPELL_SOUNDS[spellId];
  if (ancientSounds) {
    return castWithTargetImpact(ancientSounds[0], ancientSounds[1], event.spellCast, PROJ_ANIM_TIMINGS.magic_spell);
  }
  if (spellId === 'Dark Demonbane') {
    return resolveProjectileLayeredAttack(event, DARK_DEMONBANE_CAST[0], DARK_DEMONBANE_CAST[1]);
  }

  const weaponId = event.weaponId === undefined ? undefined : getEquipmentCombatBaseId(event.weaponId);
  const usingSpecialAttack = event.usingSpecialAttack === true;

  if (typeof weaponId === 'number') {
    if (weaponId === 29000) {
      return ECLIPSE_ATLATL_ATTACK;
    }
    if (TUMEKENS_SHADOW_WEAPONS.has(weaponId)) {
      return castWithTargetImpact(
        TUMEKENS_SHADOW_CAST,
        TUMEKENS_SHADOW_IMPACT,
        event.spellCast,
        PROJ_ANIM_TIMINGS.tumekens_shadow,
      );
    }
    if (usingSpecialAttack) {
      if (TOXIC_BLOWPIPE_WEAPONS.has(weaponId)) return TOXIC_BLOWPIPE_SPEC;
      if (DRAGON_CLAWS_WEAPONS.has(weaponId)) return DRAGON_CLAWS_SPEC;
      if (SPEC_SOUND_GODSWORD_WEAPONS.has(weaponId)) return GODSWORD_SPEC;
      if (WHIP_WEAPONS.has(weaponId)) return WHIP_SPEC;
      if (EMBERLIGHT_WEAPONS.has(weaponId)) return EMBERLIGHT_SPEC;
      if (ARMADYL_CROSSBOW_WEAPONS.has(weaponId)) return ARMADYL_CROSSBOW_SPEC;
      if (VOIDWAKER_WEAPONS.has(weaponId)) return VOIDWAKER_SPEC;
      if (ELDER_MAUL_WEAPONS.has(weaponId)) return ELDER_MAUL_SPEC;
      if (ABYSSAL_BLUDGEON_WEAPONS.has(weaponId)) return ABYSSAL_BLUDGEON_SPEC;
      if (BURNING_CLAWS_WEAPONS.has(weaponId)) return BURNING_CLAWS_SPEC;
      if (SCORCHING_BOW_WEAPONS.has(weaponId)) return scorchingBowSpecSounds(event);
      if (SOULREAPER_AXE_WEAPONS.has(weaponId)) return SOULREAPER_AXE_SPEC;
      if (DRAGON_WARHAMMER_WEAPONS.has(weaponId)) return DRAGON_WARHAMMER_SPEC;
      if (SILENT_SPEC_WEAPONS.has(weaponId)) return null;
    }

    // Specs replace the normal swing; style mappings precede weapon-only mappings.
    const styleSound = resolveStyleAttackSound(weaponId, event.attackKind);
    if (styleSound !== undefined) {
      return styleSound;
    }
    if (INQUISITORS_MACE_WEAPONS.has(weaponId)) {
      return INQUISITORS_MACE_ATTACK;
    }
    if (SCYTHE_OF_VITUR_WEAPONS.has(weaponId)) {
      return SCYTHE_OF_VITUR_ATTACK;
    }
    if (GODSWORD_WEAPONS.has(weaponId)) {
      return event.attackKind === 'melee_crush' ? GODSWORD_SMASH : GODSWORD_ATTACK;
    }
    if (ELDER_MAUL_WEAPONS.has(weaponId)) return ELDER_MAUL_ATTACK;
    if (WHIP_WEAPONS.has(weaponId)) return WHIP_ATTACK;
    if (TOXIC_BLOWPIPE_WEAPONS.has(weaponId)) {
      return TOXIC_BLOWPIPE_ATTACK;
    }
    if (BOWFA_SOUND_WEAPONS.has(weaponId)) return BOWFA_ATTACK;
    if (VENATOR_BOW_WEAPONS.has(weaponId)) {
      return [VENATOR_BOW_ATTACK, ...VENATOR_BOW_RICOCHETS.slice(0, event.ricochets?.length ?? 0)];
    }
    if (BURNING_CLAWS_WEAPONS.has(weaponId) || DRAGON_CLAWS_WEAPONS.has(weaponId)) {
      return CLAWS_ATTACK;
    }
    if (EYE_OF_AYAK_WEAPONS.has(weaponId)) {
      return usingSpecialAttack
        ? EYE_OF_AYAK_SPEC
        : castWithTargetImpact(
            EYE_OF_AYAK_CAST[0],
            EYE_OF_AYAK_CAST[1],
            event.spellCast,
            PROJ_ANIM_TIMINGS.eye_of_ayak,
          );
    }
    // Only the trident's own built-in cast; a manual cast carries its spell's sounds.
    if (spellId === undefined && TRIDENT_WEAPONS.has(weaponId)) {
      return castWithTargetImpact(TRIDENT_CAST, TRIDENT_IMPACT, event.spellCast, PROJ_ANIM_TIMINGS.magic_spell);
    }
    if (usingSpecialAttack && (ACCURSED_SCEPTRE_WEAPONS.has(weaponId) || ACCURSED_SCEPTRE_A_WEAPONS.has(weaponId))) {
      return condemnSounds(event);
    }
    // The (a) sceptre autocasts spellbook spells, which carry their own sounds; only the powered
    // sceptre's own attack is this cast.
    if (ACCURSED_SCEPTRE_WEAPONS.has(weaponId)) return ACCURSED_SCEPTRE_CAST;
    if (findWeaponCategoryKey(weaponId) === 'crossbow') return RANGE_CROSSBOW;
  }

  return ATTACK_KIND_SOUNDS[event.attackKind] ?? null;
}

const PLAYER_ATTACK_PRELOAD_IDS: number[] = [
  ...Object.values(ATTACK_KIND_SOUNDS),
  RANGE_CROSSBOW,
  ECLIPSE_ATLATL_ATTACK,
  TOXIC_BLOWPIPE_ATTACK,
  TOXIC_BLOWPIPE_SPEC_SOUND,
  BOWFA_ATTACK,
  VENATOR_BOW_ATTACK,
  ...VENATOR_BOW_RICOCHETS,
  INQUISITORS_MACE_ATTACK,
  SCYTHE_OF_VITUR_ATTACK,
  GODSWORD_ATTACK,
  GODSWORD_SMASH,
  ELDER_MAUL_ATTACK,
  WHIP_ATTACK,
  WHIP_SPEC,
  ...EMBERLIGHT_SPEC.map((sound) => sound.id),
  ARMADYL_CROSSBOW_SPEC.id,
  ...DRAGON_CLAWS_SPEC.map((sound) => sound.id),
  GODSWORD_SPEC,
  VOIDWAKER_SPEC_CAST,
  VOIDWAKER_SPEC_IMPACT,
  ELDER_MAUL_SPEC.id,
  ...ABYSSAL_BLUDGEON_SPEC.map((sound) => sound.id),
  CLAWS_ATTACK,
  BURNING_CLAWS_SPEC_SOUND,
  ...SCORCHING_BOW_LAUNCH.map((sound) => (typeof sound === 'number' ? sound : sound.id)),
  ...SCORCHING_BOW_IMPACT,
  SOULREAPER_AXE_SPEC,
  DRAGON_WARHAMMER_SPEC,
  TRIDENT_IMPACT,
  ...Object.values(STYLE_ATTACK_SOUNDS).flatMap((byKind) =>
    Object.values(byKind).filter((id): id is number => typeof id === 'number'),
  ),
  ...DARK_DEMONBANE_CAST,
  ...Object.values(ANCIENT_SPELL_SOUNDS).flat(),
  ACCURSED_SCEPTRE_CAST,
  ...ACCURSED_SCEPTRE_SPEC,
  TUMEKENS_SHADOW_CAST,
  TUMEKENS_SHADOW_IMPACT,
  ...EYE_OF_AYAK_CAST,
  ...EYE_OF_AYAK_SPEC.map((sound) => sound.id),
];

export const coreAudioRules: Record<string, SoundRule> = {
  attack_started: {
    resolve: (event: GameEvent) => {
      const sound = resolvePlayerAttackSound(event);
      return sound !== null ? play(sound) : silent;
    },
    preloadIds: PLAYER_ATTACK_PRELOAD_IDS,
  },

  hit_applied: {
    // Only the splash lives here: it is a property of the ATTACK ROLL, which no hitsplat records.
    // The defend sound keys off the hitsplat's type instead, on `hitsplat_spawned` below.
    resolve: (event: GameEvent) => {
      const e = event as Record<string, unknown>;
      if (e.targetId === PLAYER_ACTOR_ID) return silent;
      // A spell that misses splashes on the target instead of producing a hitsplat sound: 227
      // is on 94/94 `failedspell_impact` spotanims across the captures, and they send it as a
      // `sound_area` at the TARGET's tile — 31% are far enough away to be silent, so playing it
      // unpositioned makes splashes far louder here than in the real client.
      const magicMiss = e.accurate === false && typeof e.attackKind === 'string' && e.attackKind.startsWith('magic');
      if (!magicMiss) return silent;
      return play(MAGIC_SPLASH, { position: coordinateFrom(e.targetPosition), range: MAGIC_SPLASH_RANGE });
    },
    preloadIds: [MAGIC_SPLASH],
  },

  hitsplat_spawned: {
    /**
     * One sound per hitsplat on the LOCAL PLAYER, keyed by the splat's own type — see the table in
     * docs/architecture/audio-sound-ids.md. Poison, venom, disease, doom and every hitsplat on an
     * NPC are silent in every capture, so this must stay a whitelist: keying off damage > 0
     * instead gives every poison tick a human grunt.
     */
    resolve: (event: GameEvent) => {
      const e = event as Record<string, unknown>;
      if (e.targetId !== PLAYER_ACTOR_ID) return silent;
      if (e.hitsplatType === 'block') return play({ id: PLAYER_BLOCK_SOUND, delayCycles: HITSPLAT_DELAY_CYCLES });
      if (e.hitsplatType !== 'damage') return silent;
      return play({ id: pickVariant(PLAYER_DAMAGE_SOUNDS), delayCycles: HITSPLAT_DELAY_CYCLES });
    },
    preloadIds: [...PLAYER_DAMAGE_SOUNDS, PLAYER_BLOCK_SOUND],
  },

  prayer_changed: {
    resolve: (event: GameEvent) => {
      const to = (event as Record<string, unknown>).to as string | null;
      if (to !== null) {
        const sound = PRAYER_ACTIVATION_SOUNDS[to];
        return sound != null ? play(sound) : silent;
      }
      return play(PRAYER_DEACTIVATE);
    },
    preloadIds: [...Object.values(PRAYER_ACTIVATION_SOUNDS), PRAYER_DEACTIVATE],
  },

  prayer_depleted: {
    resolve: () => play(PRAYER_DEPLETE_TWINKLE),
    preloadIds: [PRAYER_DEPLETE_TWINKLE],
  },

  prayer_activation_failed: {
    resolve: () => play(PRAYER_DEPLETE_TWINKLE),
    preloadIds: [PRAYER_DEPLETE_TWINKLE],
  },

  item_consumed: {
    resolve: (event: GameEvent) => {
      if (!isCoreEvent(event, 'item_consumed')) return silent;
      if (SURGE_POTION_IDS.has(event.itemId)) return play([SURGE_POTION_DRINK, DRINK_POTION]);
      return play(event.track === 'potion' ? DRINK_POTION : EAT_FOOD);
    },
    preloadIds: [EAT_FOOD, DRINK_POTION, SURGE_POTION_DRINK],
  },

  item_equipped: {
    resolve: (event: GameEvent) => {
      const e = event as Record<string, unknown>;
      const weaponSound =
        e.slot === 'weapon' && typeof e.itemId === 'number'
          ? WEAPON_EQUIP_SOUNDS[getEquipmentCombatBaseId(e.itemId)]
          : undefined;
      return play(weaponSound ?? EQUIP_SOUND_BY_KIND[e.equipSound as string] ?? EQUIP_FUN);
    },
    preloadIds: [
      EQUIP_FUN,
      EQUIP_METAL_BODY,
      EQUIP_HELMET,
      EQUIP_LEGS,
      EQUIP_HANDS,
      EQUIP_STAFF,
      ...Object.values(WEAPON_EQUIP_SOUNDS),
    ],
  },

  spell_self_cast: {
    resolve: (event: GameEvent) => {
      const spotAnimId = (event as Record<string, unknown>).spotAnimId;
      if (spotAnimId === SpotAnimID.VFX_PLAYER_MARK_OF_DARKNESS) return play(MARK_OF_DARKNESS_CAST);
      if (DEATH_CHARGE_CAST_SPOTANIMS.has(spotAnimId)) return play(DEATH_CHARGE_CAST);
      return silent;
    },
    preloadIds: [...MARK_OF_DARKNESS_CAST, DEATH_CHARGE_CAST],
  },

  death_charge_proc: {
    resolve: () => play(DEATH_CHARGE_PROC),
    preloadIds: [DEATH_CHARGE_PROC],
  },

  ground_item_taken: {
    resolve: () => play(ITEM_PICKUP),
    preloadIds: [ITEM_PICKUP],
  },

  player_graphic_applied: {
    resolve: (event: GameEvent) => {
      const spotAnimId = (event as Record<string, unknown>).spotAnimId;
      if (spotAnimId === SATURATED_HEART_SPOTANIM) return play(SATURATED_HEART_ACTIVATED);
      if (spotAnimId === SpotAnimID.VFX_PLAYER_REDEMPTION) return play(REDEMPTION_HEAL);
      return silent;
    },
    preloadIds: [SATURATED_HEART_ACTIVATED, REDEMPTION_HEAL],
  },

  npc_graphic_applied: {
    resolve: (event: GameEvent) =>
      SCATTER_ASHES_SPOTANIMS.has((event as Record<string, unknown>).spotAnimId) ? play(SCATTER_ASHES_KILL) : silent,
    preloadIds: [SCATTER_ASHES_KILL.id],
  },

  status_effect_expired: {
    resolve: (event: GameEvent) => {
      const effect = (event as Record<string, unknown>).effect;
      if (effect === 'mark_of_darkness') return play(MARK_OF_DARKNESS_FADED);
      if (effect === 'saturated_heart') return play(SATURATED_HEART_FADED);
      if (effect === 'death_charge') return play(DEATH_CHARGE_FADED);
      return silent;
    },
    preloadIds: [MARK_OF_DARKNESS_FADED, SATURATED_HEART_FADED, DEATH_CHARGE_FADED],
  },

  actor_died: {
    // `actor_died` fires for NPCs too, and 512 is the human death synth: ungated, every
    // boss kill ends on the player's own death cry. An NPC's death sounds live in its
    // death animation's frame sounds (Yama: seq 12161) and play through FrameSoundTracker.
    resolve: (event: GameEvent) =>
      (event as Record<string, unknown>).actorId === PLAYER_ACTOR_ID ? play(PLAYER_DEATH) : silent,
    preloadIds: [PLAYER_DEATH],
  },
};
