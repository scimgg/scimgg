import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { canNpcActThisTurn } from '../../core/npcDeath';
import { createNpcDefinition } from '../../core/npcs';
import {
  calculateLinearPatrolMove,
  type LinearPatrolRoute,
  type LinearPatrolState,
} from '../../core/npcs/linearPatrol';
import type { Coordinate } from '../../types/simulation';
import { createInfernoActor } from './actors';

export const glyphDefinition = createNpcDefinition<LinearPatrolState, LinearPatrolRoute>({
  id: 'inferno-glyph',
  onDamageResolved: ({ actor, damage, context }) => {
    if (damage.hpAfter <= 0) return;
    emitEncounterVisual(context.tickEvents, {
      animations: [{ actorId: actor.id, clipId: 'hit', delayCycles: 0 }],
      projectiles: [],
      graphics: [],
    });
  },
  move: ({ actor, config, context }) => {
    if (!canNpcActThisTurn(actor, context.tick)) return [];
    const result = calculateLinearPatrolMove(actor, config, context.tick);
    if (!result) return [];
    actor.state.targetEndpoint = result.state.targetEndpoint;
    actor.state.nextMoveTick = result.state.nextMoveTick;
    return [result.movement];
  },
});

export function createGlyph(options: {
  readonly id: string;
  readonly position: Readonly<Coordinate>;
  readonly spawnTick: number;
  readonly targetEndpoint: LinearPatrolState['targetEndpoint'];
}) {
  return glyphDefinition.createActor(
    {
      ...createInfernoActor('shield', options.id, [...options.position]),
      lockedFacing: 0,
      spawnTick: options.spawnTick,
    },
    {
      targetEndpoint: options.targetEndpoint,
      nextMoveTick: options.spawnTick + 1,
    },
  );
}
