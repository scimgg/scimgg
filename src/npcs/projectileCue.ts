import type { NpcActor } from '../core/actors/NpcActor';
import type { PlayerActor } from '../core/actors/PlayerActor';
import type { NpcVisualTarget } from '../core/events/encounterVisual';
import type { Coordinate } from '../types/simulation';

/**
 * Helpers for building NPC projectile cues (`NpcProjectileCue`, in `core/events/encounterVisual`)
 * from simulation actors. `render/effects/NpcProjectileFlights` draws the cues.
 */

/** Homes onto the actor; `position` is where a flight aims if the actor is never seen rendered. */
export function actorVisualTarget(actor: Pick<NpcActor | PlayerActor, 'id' | 'size' | 'position'>): NpcVisualTarget {
  return { kind: 'actor', actorId: actor.id, size: actor.size, position: [...actor.position] };
}

/** World-space center of an NPC's center tile, where its projectiles launch. */
export function npcProjectileSource(actor: Pick<NpcActor, 'size' | 'position'>): Coordinate {
  const offset = Math.floor(actor.size / 2) + 0.5;
  return [actor.position[0] + offset, actor.position[1] + offset];
}
