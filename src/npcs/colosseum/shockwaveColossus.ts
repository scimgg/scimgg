import { calculateProjectileEndTime, type ProjAnimTiming } from '../../core/combat/hitDelay';
import { type AttackPlan, projectileDistance, resolveAttackRequest } from '../../core/combat/npcAttackRequest';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { canNpcActThisTurn } from '../../core/npcDeath';
import { createNpcDefinition, type DefinedNpcActor } from '../../core/npcs';
import { actorVisualTarget, npcProjectileSource } from '../projectileCue';
import {
  type ColossusActorInput,
  canColossusLaunch,
  createColossusActor,
  moveColossus,
  scheduleColossusAttack,
} from './colossusReach';
import { COLOSSEUM_SPOTANIMS, type ColosseumRelentlessRank } from './constants';
import { withRelentlessDefence, withRelentlessPlan } from './relentless';

/**
 * Fortis Colosseum Shockwave Colossus: single-target magic, no ground cue (W-NPC "no special mechanics";
 * no map_anim in any of 63 captured casts). Capture facts and labels:
 * `docs/encounters/fortis-colosseum-facts-spec.md` §6.2 and §6.7; stats are the Wiki infobox
 * (/w/Shockwave_Colossus?oldid=15200488) as synced into `monsters.json`.
 */
export const SHOCKWAVE_COLOSSUS_NPC_ID = 12819; // COLOSSEUM_SHOCKWAVE_COLOSSUS

/** RuneLite gameval names; idle and walk are the cache NpcType's (rev 232). */
export const SHOCKWAVE_COLOSSUS_SEQS = {
  idle: 10902, // NPC_COLOSSI_SHOCKWAVE_01_IDLE
  walk: 10881, // NPC_COLOSSI_SHOCKWAVE_01_WALK
  attack: 10903, // NPC_COLOSSI_SHOCKWAVE_01_CLAPATTACK, every cast (63)
  death: 10895, // NPC_COLOSSI_SHOCKWAVE_01_DEATH
} as const;

export const SHOCKWAVE_COLOSSUS_SPOTANIMS = {
  projectile: COLOSSEUM_SPOTANIMS.shockwaveProjectile, // A:2431
  /** On the player, `delay` = the projectile's end; missing on ~14/63 casts (slot conflicts), never a cue. */
  impact: COLOSSEUM_SPOTANIMS.shockwaveImpact,
} as const;
const IMPACT_HEIGHT = 64;

/** VERIFIED: removed four ticks after the death sequence starts (7/7). Removal belongs to the wave owner. */
export const SHOCKWAVE_DEATH_TO_REMOVAL_TICKS = 4;

/**
 * VERIFIED (63/63): `starttime=50`, `endtime = 76 + 8d` with d the Chebyshev distance from the colossus's
 * center to the target tile (`projectileDistance`), `progress=40`; the splat lands at launch + floor(end/30)
 * (62/63, the miss after the player's death at B:3404): d 2–5 +3, 6–9 +4, 10–12 +5, 13–16 +6.
 */
export const SHOCKWAVE_PROJECTILE_TIMING = {
  delay: 50,
  lengthAdjustment: 26,
  stepMultiplier: 8,
  progress: 40,
} as const satisfies ProjAnimTiming;
const PROJECTILE_FLIGHT = { slope: 0, startHeight: 158, endHeight: 100 } as const;

const MAGIC_PLAN = {
  formulaStyle: 'magic',
  damageType: 'magic',
  attackKind: 'magic_shadow',
  impactDelayTicks: 0,
  projectile: SHOCKWAVE_PROJECTILE_TIMING,
  // Wiki infobox; one unprayed sample, 21 under Relentless III (B:3399 → 3403).
  maxHit: 56,
  // VERIFIED: the hit lands after the colossus dies (B:3293 → 3298, C:3480 → 3484).
  sourceDeathPolicy: 'persist',
  // Protection at launch (the default): 9/9 prayed at launch and off on landing were 0; no reverse witness.
} as const satisfies AttackPlan;

interface ShockwaveColossusState {
  readonly relentless: ColosseumRelentlessRank;
}
export type ShockwaveColossusActor = DefinedNpcActor<ShockwaveColossusState>;

export const shockwaveColossusDefinition = createNpcDefinition<ShockwaveColossusState, undefined>({
  id: 'colosseum-shockwave-colossus',
  /**
   * CAPTURE-FIT (7/7 deaths): the death sequence starts on the killing tick after a trailing hit (C:2785
   * [0, 2, 0]) and a tick later otherwise (A:2454 → 2455), the queued rule. Its killing-tick turn launches
   * nothing (`canColossusLaunch`).
   */
  deathPolicy: 'queued',
  move: ({ actor, context }) => moveColossus(actor, context),
  tick: ({ actor, context }) => {
    const none = { environmentalDamages: [] };
    const { tick } = context;
    const player = context.world.getPlayer();
    if (!canNpcActThisTurn(actor, tick) || !canColossusLaunch(actor, player, tick)) return none;
    scheduleColossusAttack(actor, tick);
    const { relentless } = actor.state;
    const attack = resolveAttackRequest({
      attacker: actor,
      target: relentless === 0 ? player : withRelentlessDefence(player, relentless),
      plan: relentless === 0 ? MAGIC_PLAN : withRelentlessPlan(MAGIC_PLAN, relentless),
      random: context.random,
    });
    if (attack === null) throw new TypeError(`Missing formula stats for ${actor.id}`);
    const endDelayCycles = calculateProjectileEndTime(SHOCKWAVE_PROJECTILE_TIMING, projectileDistance(actor, player));
    emitEncounterVisual(context.tickEvents, {
      animations: [{ actorId: actor.id, clipId: 'attack', delayCycles: 0 }],
      graphics: [
        {
          spotAnimId: SHOCKWAVE_COLOSSUS_SPOTANIMS.impact,
          target: { kind: 'attached', actorId: player.id },
          delayCycles: endDelayCycles,
          height: IMPACT_HEIGHT,
        },
      ],
      projectiles: [
        {
          ...PROJECTILE_FLIGHT,
          spotAnimId: SHOCKWAVE_COLOSSUS_SPOTANIMS.projectile,
          startDelayCycles: SHOCKWAVE_PROJECTILE_TIMING.delay,
          endDelayCycles,
          startOffset: SHOCKWAVE_PROJECTILE_TIMING.progress,
          sourcePosition: npcProjectileSource(actor),
          target: actorVisualTarget(player),
        },
      ],
    });
    return { environmentalDamages: [], npcAttacks: [attack] };
  },
});

export function createShockwaveColossus(
  input: ColossusActorInput & {
    /** The run's Relentless tier; omitted means the modifier is off. */
    readonly relentless?: ColosseumRelentlessRank;
  },
): ShockwaveColossusActor {
  const actor = createColossusActor(input, {
    npcTypeId: SHOCKWAVE_COLOSSUS_NPC_ID,
    archetypeId: 'colosseum_shockwave_colossus',
    attackStyle: 'magic',
    seqs: SHOCKWAVE_COLOSSUS_SEQS,
  });
  return shockwaveColossusDefinition.createActor(actor, { relentless: input.relentless ?? 0 });
}
