import type { NpcActor } from '../../core/actors/NpcActor';
import type { PlayerActor } from '../../core/actors/PlayerActor';
import type { PrayerCheckTiming } from '../../core/combat/CombatSystem';
import type { CombatFormulaStyle } from '../../core/combat/formulaTypes';
import { isNpcActionReady, scheduleNpcAction } from '../../core/combat/npcActionClock';
import {
  type AttackPlan,
  canNpcAttack,
  isNpcInMeleeRange,
  projectileDistance,
  resolveAttackRequest,
} from '../../core/combat/npcAttackRequest';
import { contextAttackDecisions, contextDecisions } from '../../core/decisionRandom';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { canNpcActThisTurn, canReceiveNewAttack } from '../../core/npcDeath';
import { createNpcDefinition, type NpcDefinitionContext } from '../../core/npcs';
import type { Coordinate } from '../../types/simulation';
import { createInfernoActor, type InfernoVariant } from './actors';
import { demonstrateJad } from './demonstrations';
import { emitZukAttack, emitZukDeath } from './events';
import { jadHealerDefinition } from './jadHealer';
import { presentInfernoDamage } from './presentation';
import { JALTOK_JAD_PROJECTILE_TIMING } from './projectileProfiles';
import { resolveReadyTarget } from './targetResolution';

export type JadStyle = 'magic' | 'range' | 'melee';
export type JadOptions = {
  readonly id: string;
  readonly position: Coordinate;
  readonly spawnTick: number;
  readonly targetId: string | null;
  /** Defaults to the wave-69 type (7704); `ordinary` is waves 67-68's 7700. */
  readonly variant?: InfernoVariant;
  /** Overrides the execution's opening for this Jad (wave 68 staggers three: +4/+7/+10). */
  readonly initialDelayTicks?: number;
  /** Overrides the execution's ranged/magic period for this Jad (wave 68: 9). */
  readonly rangedMagicPeriod?: 8 | 9;
};
type JadFormulaStyle = {
  readonly magic: 'magic';
  readonly range: 'ranged';
  readonly melee: Extract<CombatFormulaStyle, `melee_${string}`>;
};
export type JadExecution = {
  readonly attackRange: number;
  readonly initialDelayTicks?: number;
  readonly selectStyle: (input: {
    readonly actor: NpcActor;
    readonly target: PlayerActor | NpcActor;
    readonly context: NpcDefinitionContext;
  }) => JadStyle | null;
  readonly profiles: {
    readonly [Style in JadStyle]: {
      readonly windupTicks: number;
      readonly attack: Omit<
        AttackPlan,
        'windupTicks' | 'prayerCheckAt' | 'damageType' | 'formulaStyle' | 'sourceDeathPolicy'
      > & {
        readonly damageType: Style;
        readonly formulaStyle: JadFormulaStyle[Style];
      };
    };
  };
  // Relative to release, never the cue.
  readonly prayerCheckAtRelease: PrayerCheckTiming;
  readonly rangedMagicPeriod?: 8 | 9;
};
type JadState = {
  healersSpawned: boolean;
  removeAt: number | null;
  pendingAttack: { readonly style: JadStyle; readonly targetId: string; readonly releaseTick: number } | null;
  readonly initialDelayTicks?: number;
  readonly rangedMagicPeriod?: 8 | 9;
};
type JadConfig = {
  readonly spawnHealers: (parentId: string, context: NpcDefinitionContext) => void;
  readonly execution?: JadExecution;
};

// Simulator policy for selection, opening and reach: docs/encounters/zuk-policy.md (Live Jad combat).
export const LIVE_JAD_EXECUTION: JadExecution = {
  attackRange: 15,
  initialDelayTicks: 8,
  selectStyle: ({ actor, target, context }) => {
    if (!canNpcAttack(actor, target, LIVE_JAD_EXECUTION.profiles.magic.attack)) return null;
    // Weights of a third (a half) reproduce the `roll < 1/3, < 2/3` (`< 0.5`) thresholds exactly.
    const key = { site: 'inferno.jad.style', tick: context.tick, actorId: actor.id, targetId: target.id };
    const third = 1 / 3;
    return contextDecisions(context).choose<JadStyle>(
      key,
      isNpcInMeleeRange(actor, target)
        ? [
            { value: 'magic', weight: third },
            { value: 'range', weight: third },
            { value: 'melee', weight: third },
          ]
        : [
            { value: 'magic', weight: 0.5 },
            { value: 'range', weight: 0.5 },
          ],
    );
  },
  prayerCheckAtRelease: 'launch',
  rangedMagicPeriod: 8,
  profiles: {
    magic: {
      windupTicks: 3,
      attack: {
        formulaStyle: 'magic',
        damageType: 'magic',
        attackKind: 'magic_fire',
        impactDelayTicks: 0,
        projectile: JALTOK_JAD_PROJECTILE_TIMING,
        maxHit: 113,
      },
    },
    range: {
      windupTicks: 3,
      attack: {
        formulaStyle: 'ranged',
        damageType: 'range',
        attackKind: 'range_arrow',
        impactDelayTicks: 2,
        maxHit: 113,
      },
    },
    melee: {
      windupTicks: 0,
      attack: {
        formulaStyle: 'melee_stab',
        damageType: 'melee',
        attackKind: 'melee_stab',
        impactDelayTicks: 0,
        maxHit: 113,
      },
    },
  },
};

/**
 * Ordinary waves 67-68 (docs/encounters/inferno-facts-spec.md, Jad): the live selector and
 * profiles, first tell at spawn+4 on an 8-tick cycle. Wave 68 gives each Jad a 9-tick period and its
 * own +4/+7/+10 opening through `createJad`. Healer counts (5 at wave 67, 3 per Jad at 68) belong to
 * the encounter's `spawnHealers`.
 */
export const ORDINARY_JAD_EXECUTION: JadExecution = {
  ...LIVE_JAD_EXECUTION,
  initialDelayTicks: 4,
  rangedMagicPeriod: 8,
};

export const INFERNO_WAVE_JAD_SCHEDULE = {
  67: { openingDelayTicks: [4], rangedMagicPeriod: 8, healersPerJad: 5 },
  68: { openingDelayTicks: [4, 7, 10], rangedMagicPeriod: 9, healersPerJad: 3 },
} as const;

export const jadDefinition = createNpcDefinition<JadState, JadConfig>({
  id: 'inferno-jad',
  // W69: zero headbar t983, death sequence t984, removed with his healers t990.
  deathPolicy: 'queued',
  onDamageResolved: ({ actor, damage, config, context }) => {
    presentInfernoDamage({ actor, damage, context });
    if (damage.sourceId !== 'player' || damage.effectiveDamage <= 0 || damage.hpAfter <= 0) return;
    // Inclusive half-health trigger: docs/encounters/zuk-facts-spec.md, section 2, JalTok-Jad article.
    if (!actor.state.healersSpawned && damage.hpAfter <= actor.vitals.maxHp / 2) {
      actor.state.healersSpawned = true;
      config.spawnHealers(actor.id, context);
    }
  },
  onDefeated: ({ actor, defeat }) => {
    // One observation: capture inferno-waves-69-zuk-packet-data.txt, death t984, Jad/children removed t990:
    // six ticks after the death sequence, which a queued death fixes before the defeat is reported.
    actor.state.removeAt = (actor.deathAnimationTick ?? defeat.tick) + 6;
  },
  // A windup not yet released dies with him (Jad 5173 -> 5174); a released hit persists.
  onDeathStarted: ({ actor }) => {
    actor.state.pendingAttack = null;
  },
  onDeathAnimation: ({ actor, context }) =>
    emitZukDeath(context, { actorId: actor.id, npcKind: 'jad', position: actor.position }),
  onDespawn: ({ actor, context }) => {
    actor.state.pendingAttack = null;
    for (const child of context.world.getNpcs()) {
      if (jadHealerDefinition.getState(child)?.parentId === actor.id) context.despawnNpc(child.id);
    }
  },
  tick: ({ actor, context, config }) => {
    if (!canNpcActThisTurn(actor, context.tick) || context.tick < (actor.spawnTick ?? 0))
      return { environmentalDamages: [] };
    const due = isNpcActionReady(actor.combat, context.tick);
    const execution = config.execution;
    if (!execution) return { environmentalDamages: [] };
    const initialDelayTicks = actor.state.initialDelayTicks ?? execution.initialDelayTicks ?? 0;
    if (context.tick < (actor.spawnTick ?? 0) + initialDelayTicks) return { environmentalDamages: [] };
    actor.combat.attackRange = execution.attackRange;
    const pendingTargetId = actor.state.pendingAttack?.targetId;
    const target =
      pendingTargetId !== undefined
        ? (context.world.getPlayers().find((player) => player.id === pendingTargetId) ??
          context.world.getNpc(pendingTargetId))
        : due
          ? resolveReadyTarget(actor, context.world)
          : null;
    if (!actor.state.pendingAttack && due && target && canReceiveNewAttack(target)) {
      const style = execution.selectStyle({ actor, target, context });
      if (style === null) return { environmentalDamages: [] };
      const profile = execution.profiles[style];
      if (!canNpcAttack(actor, target, profile.attack)) return { environmentalDamages: [] };
      actor.state.pendingAttack = { style, targetId: target.id, releaseTick: context.tick + profile.windupTicks };
      // JalTok-Jad article attack speed; capture normal casts are 8 apart, melee recovery is 4.
      actor.combat.attackStyle = style;
      actor.combat.attackSpeed =
        style === 'melee' ? 4 : (actor.state.rangedMagicPeriod ?? execution.rangedMagicPeriod ?? 8);
      scheduleNpcAction(actor.combat, context.tick, actor.combat.attackSpeed);
      emitEncounterVisual(context.tickEvents, {
        animations: [{ actorId: actor.id, clipId: style, delayCycles: 0 }],
        projectiles: [],
        graphics: [],
      });
      context.tickEvents.emit({ type: 'zuk_jad_cue', sourceId: actor.id, style });
    }
    const pending = actor.state.pendingAttack;
    if (!pending || context.tick < pending.releaseTick) return { environmentalDamages: [] };
    actor.state.pendingAttack = null;
    if (!target || !canReceiveNewAttack(target) || target.id !== pending.targetId) return { environmentalDamages: [] };
    const plan = execution.profiles[pending.style].attack;
    const attack = resolveAttackRequest({
      attacker: actor,
      target,
      random: context.random,
      labelled: contextAttackDecisions(context),
      // Jad's death before release clears `pendingAttack` (`onDeathStarted`), canceling the attack; what has
      // been released persists (spec section 4).
      plan: { ...plan, prayerCheckAt: execution.prayerCheckAtRelease, sourceDeathPolicy: 'persist' },
    });
    if (!attack) throw new TypeError(`Missing formula stats for ${actor.id}`);
    if (pending.style === 'magic') {
      const cue = demonstrateJad(actor, target, 'magic');
      emitEncounterVisual(context.tickEvents, {
        animations: [],
        graphics: [],
        projectiles: cue.projectiles.map((projectile) => ({
          ...projectile,
          startDelayCycles: projectile.startDelayCycles - 90,
          endDelayCycles: projectile.endDelayCycles - 90,
        })),
      });
    }
    if (pending.style === 'range') {
      emitEncounterVisual(context.tickEvents, {
        animations: [],
        projectiles: [],
        // Zero-delay rock placement is simulator policy: docs/encounters/zuk-policy.md (Live Jad combat).
        graphics: [
          { spotAnimId: 451, target: { kind: 'tile', position: [...target.position] }, height: 92, delayCycles: 0 },
        ],
      });
    }
    const impactDelayTicks = attack.impactDelayTicks;
    actor.combat.lastAttackTick = context.tick;
    emitZukAttack(context, {
      attack: `jad_${pending.style}`,
      sourceId: actor.id,
      targetId: target.id,
      sourcePosition: actor.position,
      targetPosition: target.position,
      launchTick: context.tick,
      impactTick: context.tick + impactDelayTicks,
      ...(pending.style === 'magic' ? { projectileArrivalCycles: 2 + 8 * projectileDistance(actor, target) } : {}),
    });
    return { environmentalDamages: [], npcAttacks: [attack] };
  },
});

/**
 * Removes a dead Jad, and through `onDespawn` his healers, six ticks after his death, at his own
 * NPC-turn boundary. Healers earlier in processing order may already have acted that tick.
 */
export function removeJadIfDue(actor: NpcActor, context: Pick<NpcDefinitionContext, 'tick' | 'despawnNpc'>): boolean {
  const state = jadDefinition.getState(actor);
  if (state?.removeAt === null || state?.removeAt === undefined || context.tick < state.removeAt) return false;
  context.despawnNpc(actor.id);
  return true;
}

export function createJad(options: JadOptions) {
  const actor = createInfernoActor({ kind: 'jad', variant: options.variant ?? 'zuk' }, options.id, options.position);
  actor.spawnTick = options.spawnTick;
  actor.combat.attackSpeed = options.rangedMagicPeriod ?? 8;
  actor.combat.targetId = options.targetId;
  actor.combat.retaliation = { mode: 'retarget', pending: [], lastIncomingAttackTick: null };
  return jadDefinition.createActor(actor, {
    healersSpawned: false,
    removeAt: null,
    pendingAttack: null,
    ...(options.initialDelayTicks === undefined ? {} : { initialDelayTicks: options.initialDelayTicks }),
    ...(options.rangedMagicPeriod === undefined ? {} : { rangedMagicPeriod: options.rangedMagicPeriod }),
  });
}
