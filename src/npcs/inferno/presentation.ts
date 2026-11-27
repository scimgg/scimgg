import type { NpcActor } from '../../core/actors/NpcActor';
import type { DamageAppliedInfo } from '../../core/combat/CombatSystem';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import type { NpcDefinitionContext } from '../../core/npcs';
import { emitZukHit, zukNpcKind } from './events';

export type ParentHealPresentation = (target: NpcActor, context: NpcDefinitionContext) => void;

export function presentInfernoDamage({
  actor,
  damage,
  context,
}: {
  readonly actor: NpcActor;
  readonly damage: Readonly<DamageAppliedInfo>;
  readonly context: NpcDefinitionContext;
}): void {
  if (damage.effectiveDamage < 0 || damage.hpAfter > damage.hpBefore) return;
  const npcKind = zukNpcKind(actor);
  if (npcKind === null || npcKind === 'shield') return;
  // Per-hit sound/defend policy, including zeros and burns: docs/encounters/zuk-policy.md (Presentation).
  emitZukHit(context, { actorId: actor.id, npcKind, position: actor.position });
  // Neither Jal-Zek nor the Jal-Ak children have a defend sequence (facts spec, NPCs table).
  if (damage.hpAfter <= 0 || npcKind === 'mager' || npcKind === 'blob_child') return;
  emitEncounterVisual(context.tickEvents, {
    animations: [{ actorId: actor.id, clipId: 'defend', delayCycles: 0 }],
    projectiles: [],
    graphics: [],
  });
}
