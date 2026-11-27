import type { NpcActor } from '../../core/actors/NpcActor';
import type { PlayerActor } from '../../core/actors/PlayerActor';
import { calculateProjectileEndTime } from '../../core/combat/hitDelay';
import { projectileDistance } from '../../core/combat/npcAttackRequest';
import { getCollisionMap } from '../../core/constants';
import type { NpcProjectileCue } from '../../core/events/encounterVisual';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { isArenaFootprintWalkable } from '../../core/npcMovementCollision';
import type { NpcDefinitionContext } from '../../core/npcs';
import { CollisionFlag } from '../../rs/collision/CollisionFlag';
import type { Coordinate } from '../../types/simulation';
import { actorVisualTarget, npcProjectileSource } from '../projectileCue';
import { faceInfernoAction } from './demonstrations';
import { emitZukAttack, type ZukAttackKind } from './events';
import type { InfernoWaveProjectile } from './projectileProfiles';

const BLOCKING_FLAGS = CollisionFlag.OBJECT | CollisionFlag.FLOOR_BLOCKED;

export function infernoWaveProjectileCue(
  actor: NpcActor,
  target: PlayerActor | NpcActor,
  projectile: InfernoWaveProjectile,
  endDelayCycles = calculateProjectileEndTime(projectile.timing, projectileDistance(actor, target)),
  /** Where it launches from when not the actor's current tile (Jal-Ak: its pre-movement footprint). */
  source: Pick<NpcActor, 'position' | 'size'> = actor,
): NpcProjectileCue {
  return {
    spotAnimId: projectile.spotAnimId,
    sourcePosition: npcProjectileSource(source),
    target: actorVisualTarget(target),
    startDelayCycles: Math.min(projectile.timing.delay, endDelayCycles),
    endDelayCycles,
    slope: projectile.slope,
    startOffset: projectile.timing.progress,
    startHeight: projectile.startHeight,
    endHeight: projectile.endHeight,
  };
}

/**
 * The attack's animation and projectiles, plus its `zuk_attack` sound owner. The source position is
 * the SW tile, where the captures center an attacker's `sound_area` (Jal-Nib's 595).
 */
export function emitInfernoWaveAttack(
  context: Pick<NpcDefinitionContext, 'tickEvents' | 'tick'>,
  attack: {
    readonly actor: NpcActor;
    readonly target: PlayerActor | NpcActor;
    readonly clipId: string;
    readonly kind: ZukAttackKind;
    readonly impactDelayTicks: number;
    readonly projectiles?: readonly NpcProjectileCue[];
  },
): void {
  const { actor, target, projectiles = [] } = attack;
  faceInfernoAction(actor, target);
  emitEncounterVisual(context.tickEvents, {
    animations: [{ actorId: actor.id, clipId: attack.clipId, delayCycles: 0 }],
    projectiles,
    graphics: [],
  });
  const arrival = projectiles[0]?.endDelayCycles;
  emitZukAttack(context, {
    attack: attack.kind,
    sourceId: actor.id,
    targetId: target.id,
    sourcePosition: actor.position,
    targetPosition: target.position,
    launchTick: context.tick,
    impactTick: context.tick + attack.impactDelayTicks,
    ...(arrival === undefined ? {} : { projectileArrivalCycles: arrival }),
  });
}

/** Terrain and scenery allow the footprint: inside the arena, walkable, and clear of any standing pillar. */
export function isInfernoFootprintLegal(southWest: Coordinate, size: number): boolean {
  if (!isArenaFootprintWalkable(southWest, size)) return false;
  const collisionMap = getCollisionMap();
  for (let dx = 0; dx < size; dx++) {
    for (let dy = 0; dy < size; dy++) {
      if (collisionMap?.hasFlag(southWest[0] + dx, southWest[1] + dy, BLOCKING_FLAGS)) return false;
    }
  }
  return true;
}
