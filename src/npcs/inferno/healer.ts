import type { NpcActor } from '../../core/actors/NpcActor';
import type { PlayerActor } from '../../core/actors/PlayerActor';
import { isNpcActionReady, scheduleNpcAction } from '../../core/combat/npcActionClock';
import { applyNpcHealing } from '../../core/combat/npcHealing';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { canNpcActThisTurn, canReceiveHealing, canReceiveNewAttack, isNpcLiving } from '../../core/npcDeath';
import { createNpcDefinition, type NpcDefinitionContext } from '../../core/npcs';
import type { Coordinate } from '../../types/simulation';
import { createInfernoActor } from './actors';
import { demonstrateHeal } from './demonstrations';
import { emitZukDeath } from './events';
import { type ParentHealPresentation, presentInfernoDamage } from './presentation';

// docs/encounters/zuk-facts-spec.md section 6: cast t1069, visual flight 3, HP t1073; do not collapse flight and application.
const INITIAL_CAST_DELAY = 4;
const CAST_PERIOD = 3;
const HEAL_APPLICATION_DELAY = 4;
// Simulator policy, not capture measurement: docs/encounters/zuk-policy.md (Healing).
// Only the first-impact tick refuses attacks, so blowpipe zig-zag (tag A, hit B, return to A) works
// even when the return click is processed during B's cooldown.
const FIRST_ENGAGEMENT_ATTACK_LOCKOUT_TICKS = 1;

export type HealerState = {
  supportTargetId: string;
  firstEngagementTick: number | null;
  pendingHeals: { readonly targetId: string; readonly amount: number; readonly applyTick: number }[];
};
export type HealerConfig = {
  readonly castSparks?: (input: {
    readonly actor: NpcActor;
    readonly target: PlayerActor | NpcActor;
    readonly context: NpcDefinitionContext;
  }) => void;
  readonly presentHeal?: ParentHealPresentation;
  readonly sampleHeal?: (input: {
    readonly actor: NpcActor;
    readonly target: NpcActor;
    readonly context: NpcDefinitionContext;
  }) => number;
};

export const healerDefinition = createNpcDefinition<HealerState, HealerConfig | undefined>({
  id: 'inferno-healer',
  deathPolicy: 'queued',
  move: false,
  onDamageResolved: presentInfernoDamage,
  // Simulator contract, not captured game behavior: source death/despawn cancels supplied heals; reset starts a fresh queue.
  onDefeated: ({ actor }) => {
    actor.state.pendingHeals = [];
  },
  onDeathAnimation: ({ actor, context }) =>
    emitZukDeath(context, { actorId: actor.id, npcKind: 'healer', position: actor.position }),
  onDespawn: ({ actor }) => {
    actor.state.pendingHeals = [];
  },
  resolveLocalEffects: ({ actor, context, config }) => {
    const pending = actor.state.pendingHeals;
    actor.state.pendingHeals = [];
    // A dying healer heals nothing, not even on the turn it is killed in.
    if (!isNpcLiving(actor)) return [];
    for (const heal of pending) {
      if (context.tick < heal.applyTick) actor.state.pendingHeals.push(heal);
      else {
        const target = context.world.getNpc(heal.targetId);
        if (!target || !canReceiveHealing(target)) continue;
        applyNpcHealing(target, heal.amount, context.tickEvents);
        config?.presentHeal?.(target, context);
      }
    }
    return [];
  },
  tick: ({ actor, context, config }) => {
    if (!canNpcActThisTurn(actor, context.tick) || context.tick < (actor.spawnTick ?? 0))
      return { environmentalDamages: [] };
    const incomingTick = actor.combat.retaliation?.lastIncomingAttackTick;
    if (actor.state.firstEngagementTick === null && incomingTick !== null && incomingTick !== undefined) {
      actor.state.firstEngagementTick = incomingTick;
      actor.attackBlockedUntilTick = incomingTick + FIRST_ENGAGEMENT_ATTACK_LOCKOUT_TICKS;
    }
    if (actor.combat.targetId === null && context.tick < (actor.spawnTick ?? 0) + INITIAL_CAST_DELAY)
      return { environmentalDamages: [] };
    if (!isNpcActionReady(actor.combat, context.tick)) return { environmentalDamages: [] };
    if (actor.combat.targetId !== null) {
      const target =
        context.world.getPlayers().find((player) => player.id === actor.combat.targetId) ??
        context.world.getNpc(actor.combat.targetId);
      if (!target || !canReceiveNewAttack(target)) return { environmentalDamages: [] };
      emitEncounterVisual(context.tickEvents, {
        animations: [{ actorId: actor.id, clipId: 'attack', delayCycles: 0 }],
        projectiles: [],
        graphics: [],
      });
      actor.combat.lastAttackTick = context.tick;
      context.tickEvents.emit({
        type: 'zuk_healer_cast',
        sourceId: actor.id,
        targetId: target.id,
        sourcePosition: [...actor.position],
      });
      config?.castSparks?.({ actor, target, context });
    } else {
      const target = context.world.getNpc(actor.state.supportTargetId);
      // A dying healer may still cast at its attacker on its killing tick, but never heals.
      if (!isNpcLiving(actor) || !target || !canReceiveHealing(target)) return { environmentalDamages: [] };
      const { animations, projectiles } = demonstrateHeal([actor], target);
      emitEncounterVisual(context.tickEvents, { animations, projectiles, graphics: [] });
      context.tickEvents.emit({
        type: 'zuk_healer_cast',
        sourceId: actor.id,
        targetId: target.id,
        sourcePosition: [...actor.position],
      });
      if (config?.sampleHeal)
        actor.state.pendingHeals.push({
          targetId: target.id,
          amount: config.sampleHeal({ actor, target, context }),
          applyTick: context.tick + HEAL_APPLICATION_DELAY,
        });
    }
    scheduleNpcAction(actor.combat, context.tick, CAST_PERIOD);
    return { environmentalDamages: [] };
  },
});

/** Its spawn clip plays from `spawnTick` through the render config's `spawnSeqId`. */
export function createHealer(options: {
  readonly id: string;
  readonly position: Coordinate;
  readonly spawnTick: number;
  readonly supportTargetId: string;
}) {
  const actor = createInfernoActor('healer', options.id, options.position);
  actor.spawnTick = options.spawnTick;
  actor.combat.attackSpeed = CAST_PERIOD;
  actor.combat.retaliation = { mode: 'one-tick', pending: [], lastIncomingAttackTick: null };
  return healerDefinition.createActor(actor, {
    supportTargetId: options.supportTargetId,
    firstEngagementTick: null,
    pendingHeals: [],
  });
}
