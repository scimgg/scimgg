import type { PlayerActor } from '../../core/actors/PlayerActor';
import type { AttackPlan } from '../../core/combat/npcAttackRequest';
import { type ColosseumRelentlessRank, RELENTLESS_DEFENCE_BYPASS_PERCENT, RELENTLESS_MAX_HIT_BONUS } from './constants';

/**
 * Relentless (Wiki /w/Fortis_Colosseum/Modifiers) acts on the defence roll by lowering the player's
 * Defence level by the bypassed share, rounded down (MODEL; the current, boosted level is used).
 */
export function withRelentlessDefence(player: PlayerActor, rank: ColosseumRelentlessRank): PlayerActor {
  const defence = player.stats.defence;
  const bypassed = Math.floor((defence.current * RELENTLESS_DEFENCE_BYPASS_PERCENT[rank]) / 100);
  return { ...player, stats: { ...player.stats, defence: { ...defence, current: defence.current - bypassed } } };
}

/** Relentless raises the max hit, and rank III skips the accuracy roll (Wiki; UNVERIFIED per NPC type). */
export function withRelentlessPlan(
  plan: AttackPlan & { readonly maxHit: number },
  rank: ColosseumRelentlessRank,
): AttackPlan {
  return { ...plan, maxHit: plan.maxHit + RELENTLESS_MAX_HIT_BONUS[rank], ...(rank === 3 ? { alwaysHits: true } : {}) };
}
