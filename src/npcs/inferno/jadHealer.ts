import type { NpcActor } from '../../core/actors/NpcActor';
import { isNpcActionReady, scheduleNpcAction } from '../../core/combat/npcActionClock';
import {
  type AttackPlan,
  canNpcAttack,
  isNpcInMeleeRange,
  resolveAttackRequest,
} from '../../core/combat/npcAttackRequest';
import { applyNpcHealing } from '../../core/combat/npcHealing';
import { createNpcRetaliation } from '../../core/combat/retaliation';
import { contextAttackDecisions } from '../../core/decisionRandom';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { standardNpcCombatMove } from '../../core/npcCombatMovement';
import { canNpcActThisTurn, canReceiveHealing, isNpcLiving } from '../../core/npcDeath';
import { npcFootprintsOverlap } from '../../core/npcOccupancy';
import { createNpcDefinition, type NpcDefinitionContext } from '../../core/npcs';
import type { Coordinate } from '../../types/simulation';
import { createInfernoActor, type InfernoVariant } from './actors';
import { faceInfernoAction } from './demonstrations';
import { emitZukAttack } from './events';
import { type ParentHealPresentation, presentInfernoDamage } from './presentation';

// Inferno JalTok-Jad healers must be untagged and adjacent to heal (TzTok-Jad article,
// JalTok-Jad practice note); Fight Caves healers instead keep healing while tagged in range
// (Yt-HurKot article Strategy + TzTok-Jad healer note). Both heal every 4 ticks.
// https://oldschool.runescape.wiki/w/TzTok-Jad https://oldschool.runescape.wiki/w/Yt-HurKot#Strategy
const SUPPORT_PERIOD = 4;
// capture inferno-waves-1-68-packet-data.txt:177631-177680, splash 9819, movement 9820/9821, melee 9822.
const MELEE_PERIOD = 4;
const MELEE_PLAN = {
  formulaStyle: 'melee_crush',
  damageType: 'melee',
  attackKind: 'melee_crush',
  impactDelayTicks: 0,
  // Lands on the swing tick, so it is never queued; the pre-classification default.
  sourceDeathPolicy: 'cancel-before-impact',
} as const satisfies AttackPlan;

export type JadHealerState = {
  readonly parentId: string;
  supportTargetId: string;
  nextHealTick: number;
  /** First tick it moves or acts, when later than its add tick (waves 67-68: add+1). */
  readonly firstTurnTick?: number;
};

/**
 * The Jad a healer supports: living, or dying until its removal. A dying Jad is still walked to and
 * healed for show, restoring nothing (Q t4839 death: healers step to it at t4842 and heal with its 444
 * at t4843, Q:100902-100938; also Q t4944-4945, t5065). Wave 69's healers are all tagged by then.
 */
function supportedParent(actor: NpcActor & { readonly state: JadHealerState }, context: NpcDefinitionContext) {
  const parent = context.world.getNpc(actor.state.supportTargetId);
  return parent && (canReceiveHealing(parent) || parent.death !== undefined) ? parent : null;
}

const firstTurnTick = (actor: NpcActor & { readonly state: JadHealerState }) =>
  actor.state.firstTurnTick ?? actor.spawnTick ?? 0;
export type JadHealerConfig = {
  readonly presentHeal?: ParentHealPresentation;
  readonly sampleHeal?: (input: {
    readonly actor: NpcActor;
    readonly target: NpcActor;
    readonly context: NpcDefinitionContext;
  }) => number;
  readonly melee?: Omit<AttackPlan, 'damageType' | 'windupTicks' | 'sourceDeathPolicy'>;
};

export const jadHealerDefinition = createNpcDefinition<JadHealerState, JadHealerConfig | undefined>({
  id: 'inferno-jad-healer',
  deathPolicy: 'queued',
  onDamageResolved: presentInfernoDamage,
  move: ({ actor, context }) => {
    if (!canNpcActThisTurn(actor, context.tick) || context.tick < firstTurnTick(actor)) return [];
    const target = context.world.getPlayer();
    if (actor.combat.targetId !== null && (target === null || actor.combat.targetId === target.id) && !target?.alive) {
      actor.combat.targetId = null;
      if (actor.combat.retaliation) actor.combat.retaliation.lastIncomingAttackTick = null;
    }
    if (actor.combat.targetId !== null) {
      if (!target?.alive || actor.combat.targetId !== target.id) return [];
      return standardNpcCombatMove(actor, context);
    }
    const parent = supportedParent(actor, context);
    // Under its Jad it already heals; the generic underfoot escape is for combat targets (policy).
    if (!parent || npcFootprintsOverlap(actor, parent)) return [];
    // Untagged, it walks to its Jad with the generic combat step (contact destination, not the nearest
    // footprint tile): 63/64 untagged steps in P+Q while the Jad lives (P t9815, R t130-132, Q t4792-4794;
    // the other is after its death). Wave 69's one untagged step (tbow capture t301) fits either rule.
    return standardNpcCombatMove(actor, context, parent);
  },
  tick: ({ actor, context, config }) => {
    if (!canNpcActThisTurn(actor, context.tick) || context.tick < (actor.spawnTick ?? 0))
      return { environmentalDamages: [] };
    const target = supportedParent(actor, context);
    // Untagged, it faces its Jad from its add tick and through every step, not its footsteps: each add
    // and untagged walk sends a face-entity on the Jad, and none is reset (P:177523-177554, W69:14955-14962).
    if (actor.combat.targetId === null && target) faceInfernoAction(actor, target);
    if (context.tick < firstTurnTick(actor)) return { environmentalDamages: [] };
    // A dying healer may still swing on its killing tick, but never heals.
    if (
      isNpcLiving(actor) &&
      actor.combat.targetId === null &&
      context.tick >= actor.state.nextHealTick &&
      target &&
      isNpcInMeleeRange(actor, target)
    ) {
      actor.state.nextHealTick = context.tick + SUPPORT_PERIOD;
      emitEncounterVisual(context.tickEvents, {
        animations: [{ actorId: actor.id, clipId: 'heal', delayCycles: 0 }],
        projectiles: [],
        graphics: [],
      });
      if (config?.sampleHeal && canReceiveHealing(target))
        applyNpcHealing(target, config.sampleHeal({ actor, target, context }), context.tickEvents);
      config?.presentHeal?.(target, context);
    }
    const due = isNpcActionReady(actor.combat, context.tick);
    const player = context.world.getPlayer();
    const meleePlan: AttackPlan = { ...MELEE_PLAN, ...config?.melee };
    if (!due || !player?.alive || actor.combat.targetId !== player.id || !canNpcAttack(actor, player, meleePlan))
      return { environmentalDamages: [] };
    const attack =
      config?.melee &&
      resolveAttackRequest({
        attacker: actor,
        target: player,
        plan: meleePlan,
        random: context.random,
        labelled: contextAttackDecisions(context),
      });
    if (attack === null) throw new TypeError(`Missing formula stats for ${actor.id}`);
    emitEncounterVisual(context.tickEvents, {
      animations: [{ actorId: actor.id, clipId: 'melee', delayCycles: 0 }],
      projectiles: [],
      graphics: [],
    });
    emitZukAttack(context, {
      attack: 'jad_healer_melee',
      sourceId: actor.id,
      targetId: player.id,
      sourcePosition: actor.position,
      targetPosition: player.position,
      launchTick: context.tick,
      impactTick: context.tick + (attack?.impactDelayTicks ?? 0),
    });
    actor.combat.lastAttackTick = context.tick;
    scheduleNpcAction(actor.combat, context.tick, MELEE_PERIOD);
    return attack ? { environmentalDamages: [], npcAttacks: [attack] } : { environmentalDamages: [] };
  },
});

export function createJadHealer(options: {
  readonly id: string;
  readonly position: Coordinate;
  readonly spawnTick: number;
  readonly parentId: string;
  /** Defaults to the wave-69 type (7705); `ordinary` is waves 67-68's 7701. */
  readonly variant?: InfernoVariant;
  /** First tick it moves, heals or swings; defaults to the add tick (wave 69 heals on it, W69 t877). */
  readonly firstTurnTick?: number;
}) {
  const actor = createInfernoActor(
    { kind: 'jad_healer', variant: options.variant ?? 'zuk' },
    options.id,
    options.position,
  );
  actor.spawnTick = options.spawnTick;
  actor.combat.attackSpeed = MELEE_PERIOD;
  actor.combat.attackStyle = 'melee';
  actor.combat.attackRange = 1;
  // Standard retaliation at speed 4: first swing at splat + 2 (6/6 P+Q, e.g. Q t4801 -> t4803,
  // Q:100028-100074), splash cast + 3 (P t9819 -> t9822, P:177631-177679); wave 69's splashed healers
  // turn at cast + 1 and swing on arrival (W69 t881 -> t882, t886). docs/architecture/npc-retaliation.md.
  actor.combat.retaliation = createNpcRetaliation();
  return jadHealerDefinition.createActor(actor, {
    parentId: options.parentId,
    supportTargetId: options.parentId,
    nextHealTick: options.firstTurnTick ?? options.spawnTick,
    ...(options.firstTurnTick === undefined ? {} : { firstTurnTick: options.firstTurnTick }),
  });
}
