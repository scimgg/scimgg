import type { NpcActor } from '../../core/actors/NpcActor';
import type { ActorId } from '../../core/actors/types';
import { calculateProjectileEndTime } from '../../core/combat/hitDelay';
import { isNpcActionReady, scheduleNpcAction } from '../../core/combat/npcActionClock';
import {
  type AttackPlan,
  projectileDistance,
  resolveAttackRequest,
  selectNpcAttack,
  type WeightedNpcAttack,
} from '../../core/combat/npcAttackRequest';
import { createNpcRetaliation } from '../../core/combat/retaliation';
import { contextAttackDecisions, contextDecisions } from '../../core/decisionRandom';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { standardNpcCombatMove } from '../../core/npcCombatMovement';
import { canNpcActThisTurn } from '../../core/npcDeath';
import { createNpcDefinition, type NpcDefinitionInput } from '../../core/npcs';
import type { Coordinate } from '../../types/simulation';
import { createInfernoActor, type InfernoVariant, RANGER_PROFILES, type RangerVariant } from './actors';
import { demonstrateSet, faceInfernoAction } from './demonstrations';
import { emitZukAttack, emitZukDeath, type ZukAttackKind } from './events';
import { presentInfernoDamage } from './presentation';
import { JAL_XIL_PROJECTILE_TIMING, JAL_ZEK_PROJECTILE_TIMING } from './projectileProfiles';
import { type MagerResurrection, tryMagerResurrection } from './resurrection';
import { resolveReadyTarget } from './targetResolution';

export type SetMonsterSpawnOptions = {
  readonly id: ActorId;
  readonly position: Coordinate;
  readonly spawnTick: number;
  readonly initialTargetId: ActorId | null;
  readonly initialDelayTicks: number;
};

export type SetMonsterOptions = SetMonsterSpawnOptions & {
  readonly attackRange: number;
  /** Defaults to the wave-69 type (7703); `ordinary` is waves 1-68's 7699. */
  readonly variant?: InfernoVariant;
};
export type RangerOptions = SetMonsterSpawnOptions & { readonly variant: RangerVariant };

type SetMonsterState = {
  readonly firstActionTick: number;
  /** A resurrecting Jal-Zek takes no step before this tick. */
  stillUntilTick?: number;
};

// After a resurrection Jal-Zek's first step is rez+7 or later: 8/8 that moved within 60 ticks of one
// (rez+7 at P t4869, P t4931, Q t1966, Q t3459; then +8, +10, +19, +53), 26 never moved.
const STILL_AFTER_RESURRECTION_TICKS = 7;

/** Ordinary waves supply the resurrection; wave 69 registers the mager with no config. */
export type MagerConfig = { readonly resurrection?: MagerResurrection } | undefined;

const magerPlan = {
  formulaStyle: 'magic',
  damageType: 'magic',
  attackKind: 'magic_fire',
  impactDelayTicks: 0,
  projectile: JAL_ZEK_PROJECTILE_TIMING,
  // https://oldschool.runescape.wiki/w/Jal-Zek: magic maximum is not derived from its Magic level.
  maxHit: 70,
  // Released projectiles land after their source dies (Inferno 1-68: 1312→1313, 5091→5093).
  sourceDeathPolicy: 'persist',
} as const satisfies AttackPlan;

const rangerPlan = {
  formulaStyle: 'ranged',
  damageType: 'range',
  attackKind: 'range_arrow',
  impactDelayTicks: 0,
  projectile: JAL_XIL_PROJECTILE_TIMING,
  // Released projectiles land after their source dies (Inferno 1-68: 1312→1313, 5091→5093).
  sourceDeathPolicy: 'persist',
} as const satisfies AttackPlan;

type SetAttackProfile = WeightedNpcAttack & { readonly attack: ZukAttackKind };

// Equal close-range weights are simulator policy, not measured odds: docs/encounters/zuk-policy.md (Set melee).
const magerAttacks: readonly SetAttackProfile[] = [
  {
    attack: 'mager_melee',
    weight: 1,
    plan: {
      formulaStyle: 'melee_stab',
      damageType: 'melee',
      attackKind: 'melee_stab',
      impactDelayTicks: 0,
      // Lands on the swing tick, so it is never queued; the pre-classification default.
      sourceDeathPolicy: 'cancel-before-impact',
    },
  },
  { attack: 'mager_magic', weight: 1, plan: magerPlan },
];
const rangerAttacks: readonly SetAttackProfile[] = [
  {
    attack: 'ranger_melee',
    weight: 1,
    plan: {
      formulaStyle: 'melee_crush',
      damageType: 'melee',
      attackKind: 'melee_crush',
      impactDelayTicks: 0,
      // Lands on the swing tick, so it is never queued; the pre-classification default.
      sourceDeathPolicy: 'cancel-before-impact',
    },
  },
  { attack: 'ranger_range', weight: 1, plan: rangerPlan },
];

function tickSetMonster(
  { actor, context }: NpcDefinitionInput<SetMonsterState, unknown>,
  choices: readonly SetAttackProfile[],
  resurrection?: MagerResurrection,
) {
  const empty = { environmentalDamages: [] };
  if (
    !canNpcActThisTurn(actor, context.tick) ||
    context.tick < actor.state.firstActionTick ||
    !isNpcActionReady(actor.combat, context.tick)
  ) {
    return empty;
  }
  const target = resolveReadyTarget(actor, context.world);
  if (!target) return empty;
  const profile = selectNpcAttack({
    attacker: actor,
    target,
    choices,
    random: context.random,
    decisions: contextDecisions(context),
    tick: context.tick,
  });
  if (!profile) return empty;
  // Policy (Mager resurrection): rolled when it would attack, in place of that attack.
  if (resurrection && tryMagerResurrection(actor, resurrection, context)) {
    actor.state.stillUntilTick = context.tick + STILL_AFTER_RESURRECTION_TICKS;
    return empty;
  }
  const { plan } = profile;
  if (!actor.formulaStats) throw new TypeError(`Missing formula stats for ${actor.id}`);

  const attack = resolveAttackRequest({
    attacker: actor,
    target,
    plan,
    random: context.random,
    labelled: contextAttackDecisions(context),
  });
  if (attack === null) throw new TypeError(`Missing target formula stats for ${target.id}`);

  if (plan.damageType === 'melee') {
    faceInfernoAction(actor, target);
    emitEncounterVisual(context.tickEvents, {
      animations: [{ actorId: actor.id, clipId: 'melee', delayCycles: 0 }],
      projectiles: [],
      graphics: [],
    });
  } else {
    emitEncounterVisual(context.tickEvents, demonstrateSet([actor], target));
  }
  const endCycles = plan.projectile
    ? calculateProjectileEndTime(plan.projectile, projectileDistance(actor, target))
    : undefined;
  emitZukAttack(context, {
    attack: profile.attack,
    sourceId: actor.id,
    targetId: target.id,
    sourcePosition: [actor.position[0] + Math.floor(actor.size / 2), actor.position[1] + Math.floor(actor.size / 2)],
    targetPosition: target.position,
    launchTick: context.tick,
    impactTick: context.tick + attack.impactDelayTicks,
    ...(endCycles === undefined ? {} : { projectileArrivalCycles: endCycles }),
  });
  scheduleNpcAction(actor.combat, context.tick, actor.combat.attackSpeed);
  return { environmentalDamages: [], npcAttacks: [attack] };
}

// Whether it moves on its add tick is the engine's rule (an NPC added during the NPC turns steps that
// tick; wave 69's sets are added after them and first move next tick).
function moveSetMonster({ actor, context }: NpcDefinitionInput<SetMonsterState, unknown>) {
  if (context.tick < (actor.state.stillUntilTick ?? Number.NEGATIVE_INFINITY)) return [];
  return standardNpcCombatMove(actor, context);
}

// Queued deaths: W69 Jal-Xil zero headbar t155, death sequence and sound 599 at t156; Inferno 1-68 7288
// (a burn kill) attacks on its killing tick and dies at 7289.
export const magerDefinition = createNpcDefinition<SetMonsterState, MagerConfig>({
  id: 'inferno-jal-zek',
  deathPolicy: 'queued',
  onDamageResolved: presentInfernoDamage,
  onDeathAnimation: ({ actor, context }) =>
    emitZukDeath(context, { actorId: actor.id, npcKind: 'mager', position: actor.position }),
  move: moveSetMonster,
  tick: (input) => tickSetMonster(input, magerAttacks, input.config?.resurrection),
});

export const rangerDefinition = createNpcDefinition<SetMonsterState, undefined>({
  id: 'inferno-jal-xil',
  deathPolicy: 'queued',
  onDamageResolved: presentInfernoDamage,
  onDeathAnimation: ({ actor, context }) =>
    emitZukDeath(context, { actorId: actor.id, npcKind: 'ranger', position: actor.position }),
  move: moveSetMonster,
  tick: (input) => tickSetMonster(input, rangerAttacks),
});

function configureSetSpawn(actor: NpcActor, options: SetMonsterSpawnOptions): NpcActor {
  actor.spawnTick = options.spawnTick;
  actor.combat.targetId = options.initialTargetId;
  actor.combat.retaliation = createNpcRetaliation();
  // https://oldschool.runescape.wiki/w/Inferno#Monsters: both species melee diagonally with LOS.
  actor.combat.meleeReach = 'diagonal';
  return actor;
}

export function createMager(options: SetMonsterOptions) {
  const actor = configureSetSpawn(
    createInfernoActor({ kind: 'mager', variant: options.variant ?? 'zuk' }, options.id, options.position),
    options,
  );
  actor.combat.attackSpeed = 4;
  actor.combat.attackRange = options.attackRange;
  actor.combat.attackStyle = 'magic';
  return magerDefinition.createActor(actor, {
    firstActionTick: options.spawnTick + options.initialDelayTicks,
  });
}

export function createRanger(options: RangerOptions) {
  const profile = RANGER_PROFILES[options.variant];
  const actor = configureSetSpawn(
    createInfernoActor({ kind: 'ranger', variant: options.variant }, options.id, options.position),
    options,
  );
  actor.combat.attackSpeed = profile.attackSpeed;
  actor.combat.attackRange = profile.attackRange;
  actor.combat.attackStyle = 'range';
  return rangerDefinition.createActor(actor, {
    firstActionTick: options.spawnTick + options.initialDelayTicks,
  });
}
