import type { NpcActor } from '../../../core/actors/NpcActor';
import { beesDefinition } from './bees';
import { solarflareDefinition } from './solarflare';
import { healingTotemDefinition } from './totemic';

/**
 * Actors a modifier adds to a wave: Bees swarms, Solarflare orbs and healing totems. They are not
 * wave fighters, so they never hold a wave open, and the wave owner removes any still present on the
 * completion tick:
 * - Solarflare orbs are deleted on the completion tick (A:1727, 2132, 2518, 3051, 3544, 4181, 4868)
 *   and four new ones are added at the next wave's start.
 * - Bees swarms, alive or waiting to respawn, are deleted on the completion tick (B:2564, 2922,
 *   3299) and new ones are added five ticks into the next wave (B:2366, 2635, 2980, 3352).
 * - No healing totem outlived its wave: each left with its target or was killed first, the last
 *   one of every Run A wave 8–36 ticks before completion. Clearing them is a guard, not a fitted rule.
 *
 * Pending Solarflare hits are dropped with the orbs (`SolarflareDamageState.reset`): no capture
 * shows a departure on the tick before completion, so whether such a hit lands is UNVERIFIED.
 * Volatility III's molten pools (not simulated) are also removed at completion (A:4868–4869).
 */
export function isColosseumModifierActor(npc: NpcActor): boolean {
  return beesDefinition.isActor(npc) || solarflareDefinition.isActor(npc) || healingTotemDefinition.isActor(npc);
}
