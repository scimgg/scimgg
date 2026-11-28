import type { CombatSkill, PlayerStats, TimedEffectType } from '../types/playerState';
import { DIVINE_POTION_DURATION_TICKS } from '../types/playerState';
import { HALIBUT_ITEM_ID } from './itemIds';
import type { PrayerRestoreFormula } from './prayerRestoration';

export { EMPTY_VIAL_ID } from './itemIds';

import { ZUK_CONSUMABLE_ACTIONS } from './zukConsumables';

/**
 * Cooldown tracks for item consumption.
 * Each track has its own cooldown timer.
 */
export type CooldownTrack = 'food' | 'potion' | 'combo_food';

/**
 * Attack-delay ticks added to the player's next attack when an item on each
 * track is consumed.
 *
 * Values follow the wiki's fast-food table (https://oldschool.runescape.wiki/w/Food/Fast_foods);
 * karambwan, halibut and the gnome foods are the combo-food track.
 *
 * These values are universal per track — a new food item just picks a track
 * and inherits the correct attack delay automatically, with no per-item tagging.
 *
 * Attack delay stacks additively when combo-eating (e.g. shark + karambwan
 * = 3 + 2 = 5 tick delay) and only applies while a weapon cooldown is currently
 * active; eating with a ready weapon adds no delay.
 */
export const ATTACK_DELAY_BY_TRACK: Readonly<Record<CooldownTrack, number>> = {
  food: 3,
  combo_food: 2,
  potion: 0,
};

export function getAttackDelayForTrack(track: CooldownTrack): number {
  return ATTACK_DELAY_BY_TRACK[track];
}

export type ConsumePolicy =
  | { type: 'remove' }
  | { type: 'replace'; withId: number }
  | { type: 'none' }
  | { type: 'decrement' };

export type EffectOp =
  | { op: 'heal'; amount: number }
  | { op: 'heal_formula'; baseAmount: number; scaleStat?: keyof PlayerStats }
  | { op: 'overheal'; amount: number }
  | { op: 'overheal_formula'; scaleStat: keyof PlayerStats; percent: number; flat: number }
  | { op: 'delayed_heal'; amount: number; delayTicks: number; group?: string }
  | { op: 'boost_formula'; stat: keyof PlayerStats; scaleStat: keyof PlayerStats; percent: number; flat: number }
  | { op: 'drain_formula'; stat: keyof PlayerStats; percent: number; flat: number }
  | { readonly op: 'restore_prayer_formula'; readonly formula: PrayerRestoreFormula }
  | { readonly op: 'restore_all_stats'; readonly formula: StatRestoreFormula }
  | { op: 'restore_run'; amount: number }
  /** Restores special attack energy and starts the surge potion's own cooldown. */
  | { readonly op: 'surge'; readonly percent: number }
  | { op: 'cure_poison'; immunityTicks: number }
  | { op: 'reduce_poison'; amount: number }
  | { op: 'saturated_heart' }
  /** Suspends natural decay of these skills' boosts; see `expireStatDecayLocks`. */
  | { readonly op: 'divine_decay_lock'; readonly stats: readonly CombatSkill[]; readonly durationTicks: number }
  | { op: 'apply_timed_effect'; effectType: TimedEffectType; durationTicks: number }
  | { op: 'self_damage'; amount: number }
  | { readonly op: 'self_damage_formula'; readonly percent: number; readonly flat: number };

export type ItemActionOption = 'default' | 'guzzle';

/**
 * A tracked item shares that track's cooldown AND inherits its attack delay; a TRACKLESS item has
 * neither, and is an inventory option rather than a consume — the locator orb and dwarven rock
 * cake are "Feel" and "Guzzle", not food. Letting the two fields vary independently would admit a
 * def carrying a delay that nothing reads. A trackless item is still limited to ONE use per tick,
 * in `applyItemOp`.
 */
export type ItemActionDef = ItemActionEffectDef &
  ({ track: CooldownTrack; delayTicks: number } | { track?: undefined; delayTicks?: undefined });

interface ItemActionEffectDef {
  consume: ConsumePolicy;
  effects: EffectOp[];
  /** SpotAnim (graphic) ID to play on the player when this item is used. */
  playerGraphic?: number;
  minHpToUse?: number;
}

/**
 * Per-dose restore of each drained combat skill: `floor(B * percent) + flat`, capped at base.
 */
export const STAT_RESTORE_FORMULAS = {
  // https://oldschool.runescape.wiki/w/Super_restore?oldid=15183989
  super_restore: { percent: 0.25, flat: 8 },
  // https://oldschool.runescape.wiki/w/Sanfew_serum?oldid=15236706
  sanfew: { percent: 0.3, flat: 4 },
} as const;

export type StatRestoreFormula = keyof typeof STAT_RESTORE_FORMULAS;

function rangingEffects(): EffectOp[] {
  return [{ op: 'boost_formula', stat: 'ranged', scaleStat: 'ranged', percent: 0.1, flat: 4 }];
}

/** Every amount is computed from the drinker's own levels when the dose is drunk. */
function superCombatEffects(): EffectOp[] {
  return (['attack', 'strength', 'defence'] as const).map((stat) => ({
    op: 'boost_formula',
    stat,
    scaleStat: stat,
    percent: 0.15,
    flat: 5,
  }));
}

/**
 * Creates 4 registry entries where each dose replaces itself with the next dose ID.
 *
 * @param ids - Array of [dose4Id, dose3Id, dose2Id, dose1Id]
 */
export function doseChain(
  ids: [number, number, number, number],
  emptyId: number,
  track: CooldownTrack,
  delayTicks: number,
  effectsFn: () => EffectOp[],
): Record<number, ItemActionDef> {
  const [dose4Id, dose3Id, dose2Id, dose1Id] = ids;

  return {
    [dose4Id]: {
      track,
      delayTicks,
      consume: { type: 'replace', withId: dose3Id },
      effects: effectsFn(),
    },
    [dose3Id]: {
      track,
      delayTicks,
      consume: { type: 'replace', withId: dose2Id },
      effects: effectsFn(),
    },
    [dose2Id]: {
      track,
      delayTicks,
      consume: { type: 'replace', withId: dose1Id },
      effects: effectsFn(),
    },
    [dose1Id]: {
      track,
      delayTicks,
      consume: { type: 'replace', withId: emptyId },
      effects: effectsFn(),
    },
  };
}

/**
 * Helper for noteable 4-dose potions where unnoted doses are separated by a fixed step.
 */
export function doseChainByStep(
  dose4Id: number,
  step: number,
  emptyId: number,
  track: CooldownTrack,
  delayTicks: number,
  effectsFn: () => EffectOp[],
): Record<number, ItemActionDef> {
  return doseChain(
    [dose4Id, dose4Id + step, dose4Id + step * 2, dose4Id + step * 3],
    emptyId,
    track,
    delayTicks,
    effectsFn,
  );
}

function withPlayerGraphic(chain: Record<number, ItemActionDef>, playerGraphic: number): Record<number, ItemActionDef> {
  return Object.fromEntries(Object.entries(chain).map(([id, def]) => [id, { ...def, playerGraphic }]));
}

function withMinHpToUse(chain: Record<number, ItemActionDef>, minHpToUse: number): Record<number, ItemActionDef> {
  return Object.fromEntries(Object.entries(chain).map(([id, def]) => [id, { ...def, minHpToUse }]));
}

export const ITEM_ACTIONS: Readonly<Record<number, ItemActionDef>> = {
  ...ZUK_CONSUMABLE_ACTIONS,
  // Anglerfish - variable healing, can overheal above max HP
  13441: {
    track: 'food',
    delayTicks: 3,
    consume: { type: 'remove' },
    effects: [{ op: 'heal_formula', baseAmount: 3, scaleStat: 'hitpoints' }],
  },

  // Cooked moonlight antelope
  29143: {
    track: 'food',
    delayTicks: 3,
    consume: { type: 'remove' },
    effects: [
      { op: 'heal', amount: 14 },
      { op: 'delayed_heal', amount: 12, delayTicks: 7, group: 'hunter_meat' },
    ],
  },

  // Cooked karambwan - combo food (independent track from regular food)
  3144: {
    track: 'combo_food',
    delayTicks: 3,
    consume: { type: 'remove' },
    effects: [{ op: 'heal', amount: 18 }],
  },

  // 20261127-014756-Duke-Sucellus_5.jsonl:4204 and :10965–10996.
  // https://secure.runescape.com/m=news/sailing---resources--skilling-activities-poll?oldschool=1
  [HALIBUT_ITEM_ID]: {
    track: 'combo_food',
    delayTicks: 3,
    consume: { type: 'remove' },
    effects: [{ op: 'heal', amount: 20 }],
  },

  // Saturated heart - Invigorate (magic boost, not consumed)
  // Has its own 500-tick cooldown via saturatedHeartCooldownTicks; bypasses potion track.
  27641: {
    track: 'potion',
    delayTicks: 0,
    consume: { type: 'none' },
    effects: [{ op: 'saturated_heart' }],
    playerGraphic: 2287,
  },

  // Sanfew serum dose chain (UNNOTED doses)
  // Noted IDs are +1 (10926/10928/10930/10932) and should never be used for consume replacement.
  ...doseChainByStep(10925, 2, 229, 'potion', 3, () => [
    { op: 'restore_all_stats', formula: 'sanfew' },
    { op: 'restore_prayer_formula', formula: 'sanfew' },
    { op: 'cure_poison', immunityTicks: 600 },
  ]),

  ...doseChainByStep(3024, 2, 229, 'potion', 3, () => [
    { op: 'restore_all_stats', formula: 'super_restore' },
    { op: 'restore_prayer_formula', formula: 'super_restore' },
  ]),

  // https://oldschool.runescape.wiki/w/Saradomin_brew?oldid=15322175: heals and boosts Defence from
  // BASE levels; drains the other four from each one's CURRENT level.
  ...doseChainByStep(6685, 2, 229, 'potion', 3, () => [
    { op: 'overheal_formula', scaleStat: 'hitpoints', percent: 0.15, flat: 2 },
    { op: 'boost_formula', stat: 'defence', scaleStat: 'defence', percent: 0.2, flat: 2 },
    { op: 'drain_formula', stat: 'attack', percent: 0.1, flat: 2 },
    { op: 'drain_formula', stat: 'strength', percent: 0.1, flat: 2 },
    { op: 'drain_formula', stat: 'magic', percent: 0.1, flat: 2 },
    { op: 'drain_formula', stat: 'ranged', percent: 0.1, flat: 2 },
  ]),

  ...doseChainByStep(12695, 2, 229, 'potion', 3, superCombatEffects),

  // Divine super combat: the super combat boost, 10 Hitpoints, and no decay of the three boosted
  // skills for five minutes (https://oldschool.runescape.wiki/w/Divine_potion?oldid=15203520).
  ...withMinHpToUse(
    doseChain([23685, 23688, 23691, 23694], 229, 'potion', 3, () => [
      ...superCombatEffects(),
      { op: 'self_damage', amount: 10 },
      {
        op: 'divine_decay_lock',
        stats: ['attack', 'strength', 'defence'],
        durationTicks: DIVINE_POTION_DURATION_TICKS,
      },
    ]),
    11,
  ),

  // Ranging potion: floor(Ranged * 0.1) + 4 (https://oldschool.runescape.wiki/w/Ranging_potion).
  ...doseChain([2444, 169, 171, 173], 229, 'potion', 3, rangingEffects),

  // Divine ranging potion: the ranging boost, 10 Hitpoints, and no Ranged decay for five minutes;
  // needs more than 10 Hitpoints to drink (https://oldschool.runescape.wiki/w/Divine_ranging_potion).
  ...withMinHpToUse(
    doseChain([23733, 23736, 23739, 23742], 229, 'potion', 3, () => [
      ...rangingEffects(),
      { op: 'self_damage', amount: 10 },
      { op: 'divine_decay_lock', stats: ['ranged'], durationTicks: DIVINE_POTION_DURATION_TICKS },
    ]),
    11,
  ),

  // https://oldschool.runescape.wiki/w/Forgotten_brew?oldid=15191164: Magic and Prayer from BASE
  // levels; Attack, Strength and Defence drained from each one's CURRENT level.
  ...doseChainByStep(27629, 3, 229, 'potion', 3, () => [
    { op: 'boost_formula', stat: 'magic', scaleStat: 'magic', percent: 0.08, flat: 3 },
    { op: 'restore_prayer_formula', formula: 'forgotten_brew' },
    { op: 'drain_formula', stat: 'attack', percent: 0.1, flat: 2 },
    { op: 'drain_formula', stat: 'strength', percent: 0.1, flat: 2 },
    { op: 'drain_formula', stat: 'defence', percent: 0.1, flat: 2 },
  ]),

  ...doseChainByStep(4417, 2, 1980, 'potion', 3, () => [
    { op: 'overheal', amount: 5 },
    { op: 'restore_run', amount: 500 },
    { op: 'reduce_poison', amount: 1 },
  ]),

  ...doseChainByStep(5952, 2, 229, 'potion', 3, () => [{ op: 'cure_poison', immunityTicks: 1200 }]),

  // https://oldschool.runescape.wiki/w/Extended_stamina_potion: 40% energy and four minutes per dose.
  ...doseChainByStep(31638, 3, 229, 'potion', 3, () => [
    { op: 'restore_run', amount: 4000 },
    { op: 'apply_timed_effect', effectType: 'stamina', durationTicks: 400 },
  ]),

  ...doseChainByStep(31614, 3, 229, 'potion', 3, () => [{ op: 'restore_run', amount: 3900 }]),

  // Surge potion: 25% special attack energy per dose (/w/Surge_potion). RuneLite gameval ItemID
  // _4DOSESURGE..._1DOSESURGE; the noted doses sit one id above each.
  // Every drink shows vfx_surge_potion_01 on the player (weapon sweep capture, ticks 541 and 1036).
  ...withPlayerGraphic(
    doseChainByStep(30875, 3, 229, 'potion', 3, () => [{ op: 'surge', percent: 25 }]),
    3232,
  ),

  // Prayer potion: RuneLite gameval ItemID _4DOSEPRAYERRESTORE (2434) then _3.._1DOSEPRAYERRESTORE.
  ...doseChain([2434, 139, 141, 143], 229, 'potion', 3, () => [
    { op: 'restore_prayer_formula', formula: 'prayer_potion' },
  ]),

  // Snowy knight mix — a hunter's mix, which shares the potion cooldown and adds no eating or
  // attack delay (wiki, Hunter's mix). 8 hitpoints per dose, hotfixed down from 15 on
  // 21 March 2024; two doses, (2) 29183 -> (1) 29201.
  29183: {
    track: 'potion',
    delayTicks: 3,
    consume: { type: 'replace', withId: 29201 },
    effects: [{ op: 'heal', amount: 8 }],
  },
  29201: {
    track: 'potion',
    delayTicks: 3,
    consume: { type: 'remove' },
    effects: [{ op: 'heal', amount: 8 }],
  },

  229: {
    track: 'potion',
    delayTicks: 0,
    consume: { type: 'none' },
    effects: [],
  },

  // "Each use of this orb will reduce a player's health by 10 hitpoints down to a minimum of 1
  // hitpoint and cannot kill the player, similar to a dwarven rock cake" (wiki, Locator orb).
  //
  // NO track and NO delay, which is the whole point of both items: they are inventory options
  // ("Feel" / "Guzzle"), not food, so they take no consume cooldown and add no attack delay, and
  // a player drops to 1 HP by clicking once EVERY tick. Putting them on the food track let one
  // use per 3 ticks through and silently delayed the next attack by 3. The one-per-tick limit
  // is enforced in `applyItemOp`, not here.
  // Neither plays an animation or a spotanim.
  22081: {
    consume: { type: 'none' },
    effects: [{ op: 'self_damage', amount: 10 }],
  },

  7510: {
    consume: { type: 'none' },
    effects: [{ op: 'self_damage', amount: 1 }],
    minHpToUse: 3,
  },
} as const;

// https://oldschool.runescape.wiki/w/Dwarven_rock_cake?oldid=15341177#Hitpoint_depletion
const ROCK_CAKE_GUZZLE: ItemActionDef = {
  consume: { type: 'none' },
  effects: [{ op: 'self_damage_formula', percent: 0.1, flat: 1 }],
};

export function getItemAction(itemId: number, option: ItemActionOption = 'default'): ItemActionDef | undefined {
  switch (option) {
    case 'default':
      return ITEM_ACTIONS[itemId];
    case 'guzzle':
      return itemId === 7510 ? ROCK_CAKE_GUZZLE : undefined;
    default: {
      const exhaustive: never = option;
      return exhaustive;
    }
  }
}

/**
 * Effect ops that represent a persistent buff (stat boost, timed effect).
 * New effect ops with lasting benefits should be added here.
 */
const PREPOT_EFFECT_OPS: ReadonlySet<EffectOp['op']> = new Set([
  'boost_formula',
  'divine_decay_lock',
  'saturated_heart',
  'apply_timed_effect',
  'cure_poison',
]);

export function getPrepotEffects(effects: readonly EffectOp[]): EffectOp[] {
  return effects.filter((effect) => PREPOT_EFFECT_OPS.has(effect.op));
}

export function isPrepottable(def: ItemActionDef): boolean {
  return def.effects.some((effect) => PREPOT_EFFECT_OPS.has(effect.op));
}
