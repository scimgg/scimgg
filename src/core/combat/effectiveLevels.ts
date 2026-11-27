import type { PlayerFormulaActor, PrayerMultipliers } from './formulaTypes';

/**
 * `floor(level × prayer)` in whole percents, which every prayer boost is. The floating product can
 * land just under a whole number and floor a level short: `100 * 1.15` is 114.99999999999999, not
 * the 115 of floor(100 × 1.15) (https://oldschool.runescape.wiki/w/Damage_per_second/Melee).
 * `extraPercent` adds to the prayer's percentage rather than multiplying it, as soul stacks do.
 */
function prayedLevel(level: number, multiplier: number, extraPercent = 0): number {
  return Math.floor((level * (Math.round(multiplier * 100) + extraPercent)) / 100);
}

export function meleeAttackEffectiveLevel(actor: PlayerFormulaActor, prayers: PrayerMultipliers): number {
  const prayed = prayedLevel(actor.levels.attack, prayers.attack);
  const styleBonus = actor.stance === 'Accurate' ? 3 : actor.stance === 'Controlled' ? 1 : 0;
  const voidMultiplier = actor.voidSet === 'melee' ? 1.1 : 1;
  return Math.floor((prayed + styleBonus + 8) * voidMultiplier);
}

export function meleeStrengthEffectiveLevel(actor: PlayerFormulaActor, prayers: PrayerMultipliers): number {
  // Soul stacks add to the prayer percentage rather than multiplying it (/w/Soulreaper_axe).
  const prayed = prayedLevel(actor.levels.strength, prayers.strength, actor.meleeStrengthBonusPercent ?? 0);
  const styleBonus = actor.stance === 'Aggressive' ? 3 : actor.stance === 'Controlled' ? 1 : 0;
  const voidMultiplier = actor.voidSet === 'melee' ? 1.1 : 1;
  return Math.floor((prayed + styleBonus + 8) * voidMultiplier);
}

export function rangedAttackEffectiveLevel(actor: PlayerFormulaActor, prayers: PrayerMultipliers): number {
  const prayed = prayedLevel(actor.levels.ranged, prayers.ranged);
  const styleBonus = actor.stance === 'Accurate' ? 3 : 0;
  const voidMultiplier = actor.voidSet === 'ranged' || actor.voidSet === 'elite_ranged' ? 1.1 : 1;
  return Math.floor((prayed + styleBonus + 8) * voidMultiplier);
}

export function rangedStrengthEffectiveLevel(actor: PlayerFormulaActor, prayers: PrayerMultipliers): number {
  const prayed = prayedLevel(actor.rangedStrengthLevel ?? actor.levels.ranged, prayers.rangedStrength);
  const styleBonus = actor.stance === 'Accurate' ? 3 : 0;
  const voidMultiplier = actor.voidSet === 'elite_ranged' ? 1.125 : actor.voidSet === 'ranged' ? 1.1 : 1;
  return Math.floor((prayed + styleBonus + 8) * voidMultiplier);
}

export function magicAttackEffectiveLevel(actor: PlayerFormulaActor, prayers: PrayerMultipliers): number {
  const prayed = prayedLevel(actor.levels.magic, prayers.magic);
  const styleBonus = actor.stance === 'Accurate' ? 3 : actor.stance === 'Longrange' ? 1 : 0;
  const voidMultiplier = actor.voidSet === 'magic' || actor.voidSet === 'elite_magic' ? 1.45 : 1;
  return Math.floor(prayed * voidMultiplier + styleBonus + 8);
}

export function playerDefenceEffectiveLevel(actor: PlayerFormulaActor, prayers: PrayerMultipliers): number {
  return prayedLevel(actor.levels.defence, prayers.defence) + defenceStyleBonus(actor) + 8;
}

export function playerMagicDefenceEffectiveLevel(actor: PlayerFormulaActor, prayers: PrayerMultipliers): number {
  const prayedMagic = prayedLevel(actor.levels.magic, prayers.magic);
  const prayedDefence = prayedLevel(actor.levels.defence, prayers.defence);
  return Math.floor((prayedMagic * 7) / 10) + Math.floor((prayedDefence * 3) / 10) + defenceStyleBonus(actor) + 8;
}

function defenceStyleBonus(actor: PlayerFormulaActor): number {
  if (actor.stance === 'Defensive' || actor.stance === 'Longrange') return 3;
  return actor.stance === 'Controlled' ? 1 : 0;
}
