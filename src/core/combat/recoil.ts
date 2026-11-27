import type { PlayerActor } from '../actors/PlayerActor';

/**
 * Rings that reflect part of every damaging hit back at its attacker: the Ring of recoil and the
 * recoil-charged Rings of suffering, (r) and (ri) (/w/Ring_of_recoil, /w/Ring_of_suffering).
 * An uncharged Ring of suffering does not recoil.
 */
const RECOIL_RING_IDS: ReadonlySet<number> = new Set([
  2550, // Ring of recoil
  20655, // Ring of suffering (r)
  20657, // Ring of suffering (ri)
  25248, // Ring of suffering (ri)
  26762, // Ring of suffering (ri)
]);

export function wearsRecoilRing(player: PlayerActor): boolean {
  const ring = player.equipment.ring;
  return ring !== undefined && RECOIL_RING_IDS.has(ring);
}

/**
 * Damage reflected by a hit of `damage`: "10% of the damage taken, rounded down, plus 1"
 * (/w/Ring_of_recoil). A 0 hit reflects nothing.
 *
 * Simulator policy: charges are not tracked, so a Ring of recoil never breaks.
 */
export function recoilDamage(damage: number): number {
  return damage > 0 ? Math.floor(damage / 10) + 1 : 0;
}
