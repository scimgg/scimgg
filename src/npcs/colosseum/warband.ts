import { isNpcBound, type NpcActor } from '../../core/actors/NpcActor';
import type { DamageType } from '../../core/actors/types';
import { npcHitDelayFromEndTime } from '../../core/combat/hitDelay';
import { type AttackPlan, resolveAttackRequest } from '../../core/combat/npcAttackRequest';
import { emitEncounterVisual, type NpcProjectileCue } from '../../core/events/encounterVisual';
import { canNpcActThisTurn } from '../../core/npcDeath';
import { isArenaFootprintWalkable } from '../../core/npcMovementCollision';
import {
  createNpcStickyPursuitState,
  isAtStickyPursuitDestination,
  type NpcStickyPursuitProfile,
  type NpcStickyPursuitState,
  pursuePlayerSticky,
} from '../../core/npcStickyPursuit';
import { createNpcDefinition, type DefinedNpcActor } from '../../core/npcs';
import { getMonsterFormulaStats, getMonsterHp } from '../../data/monsterData';
import type { Coordinate } from '../../types/simulation';
import { actorVisualTarget, npcProjectileSource } from '../projectileCue';
import {
  COLOSSEUM_SEQS,
  COLOSSEUM_SPOTANIMS,
  type ColosseumRelentlessRank,
  WARBAND_ARCHER_NPC_ID,
  WARBAND_BERSERKER_NPC_ID,
  WARBAND_PROJECTILES,
  WARBAND_SEER_IMPACT_HEIGHT,
  WARBAND_SEER_NPC_ID,
} from './constants';
import { withRelentlessDefence, withRelentlessPlan } from './relentless';

/**
 * Fortis Colosseum Fremennik warband. Capture facts and their status labels live in
 * `docs/encounters/sol-heredit-facts-spec.md#fremennik-warband-and-quartet`; stats are the Wiki
 * infoboxes (/w/Fremennik_warband_berserker, /w/Fremennik_warband_archer, /w/Fremennik_warband_seer)
 * as synced into `monsters.json`.
 */
export type WarbanderRole = 'berserker' | 'archer' | 'seer';
export const WARBANDER_ROLES: readonly WarbanderRole[] = ['berserker', 'archer', 'seer'];

/** VERIFIED: 89/89 members stood still on spawn+1 and moved from spawn+2. */
export const WARBAND_FIRST_MOVE_TICKS = 2;
export const WARBAND_ATTACK_PERIOD_TICKS = 6;
/** VERIFIED: two steps per tick (walking one when one step remains), 1393/1393 decisions. */
export const WARBAND_MAX_STEPS = 2;

/**
 * Slot = the member's spawn offset from the formation center, one tile south of the berserker.
 * VERIFIED in every wave spawn: berserker N, archer W, seer E, and the Quartet extra S.
 */
export const WARBAND_SLOT_OFFSETS = {
  berserker: [0, 1],
  archer: [-1, 0],
  seer: [1, 0],
  quartet: [0, -1],
} as const satisfies Record<WarbanderRole | 'quartet', Readonly<Coordinate>>;

/**
 * VERIFIED: an archer or seer whose slot is a pillar or wall takes the player's south tile instead
 * (145 decisions over about 31 episodes); the berserker's and the Quartet's own fallbacks are unobserved.
 */
export const WARBAND_FALLBACK_OFFSETS: readonly Readonly<Coordinate>[] = [[0, -1]];

interface WarbanderProfile {
  readonly npcTypeId: number;
  /** VERIFIED: attacks at spawn+phase+6k (berserker 3, seer 4, archer 5), skipping a cycle out of position. */
  readonly attackPhase: number;
  readonly plan: AttackPlan & { readonly maxHit: number };
  /** Wiki: each member takes a guaranteed maximum hit from one style. */
  readonly weakness: Exclude<DamageType, 'typeless'>;
  readonly seqs: { readonly attack: number; readonly defend: number; readonly death: number };
  /** The ranged members' projectile, aimed at the target; the berserker launches nothing. */
  readonly projectile?: {
    readonly flight: Omit<NpcProjectileCue, 'sourcePosition' | 'target'>;
    /** A graphic on the target that plays as the projectile arrives. */
    readonly impact?: { readonly spotAnimId: number; readonly height: number };
  };
}

// The ranged hits land when their projectile does: endtime 30 from the adjacent tile is one tick.
export const WARBANDER_PROFILES: Readonly<Record<WarbanderRole, WarbanderProfile>> = {
  berserker: {
    npcTypeId: WARBAND_BERSERKER_NPC_ID,
    attackPhase: 3,
    // CAPTURE-FIT: lands the tick after the swing in both swings with a hitsplat (C:1801 -> 1802,
    // A:1788 -> 1789, 9 each); the third captured swing (B:3356) is on its killing tick and never
    // lands (no splat at 3357), so the member's death cancels it.
    plan: {
      formulaStyle: 'melee_stab',
      damageType: 'melee',
      attackKind: 'melee_stab',
      impactDelayTicks: 1,
      maxHit: 29,
      sourceDeathPolicy: 'cancel-before-impact',
    },
    weakness: 'magic',
    seqs: COLOSSEUM_SEQS.warband.berserker,
  },
  archer: {
    npcTypeId: WARBAND_ARCHER_NPC_ID,
    attackPhase: 5,
    plan: {
      formulaStyle: 'ranged',
      damageType: 'range',
      attackKind: 'range_arrow',
      impactDelayTicks: npcHitDelayFromEndTime(WARBAND_PROJECTILES.archer.endDelayCycles),
      maxHit: 14,
      // A released projectile; no captured archer death falls between its launch and impact.
      sourceDeathPolicy: 'persist',
    },
    weakness: 'melee',
    seqs: COLOSSEUM_SEQS.warband.archer,
    projectile: { flight: WARBAND_PROJECTILES.archer },
  },
  seer: {
    npcTypeId: WARBAND_SEER_NPC_ID,
    attackPhase: 4,
    plan: {
      formulaStyle: 'magic',
      damageType: 'magic',
      attackKind: 'magic_fire',
      impactDelayTicks: npcHitDelayFromEndTime(WARBAND_PROJECTILES.seer.endDelayCycles),
      maxHit: 12,
      // A released projectile; no captured seer death falls between its launch and impact.
      sourceDeathPolicy: 'persist',
    },
    weakness: 'range',
    seqs: COLOSSEUM_SEQS.warband.seer,
    projectile: {
      flight: WARBAND_PROJECTILES.seer,
      impact: { spotAnimId: COLOSSEUM_SPOTANIMS.fireblastImpact, height: WARBAND_SEER_IMPACT_HEIGHT },
    },
  },
};

interface WarbanderState {
  readonly role: WarbanderRole;
  readonly slotOffset: Readonly<Coordinate>;
  readonly fallbackOffsets: readonly Readonly<Coordinate>[];
  readonly route: NpcStickyPursuitState;
  readonly relentless: ColosseumRelentlessRank;
}
export type WarbanderActor = DefinedNpcActor<WarbanderState>;

function spawnTickOf(actor: NpcActor): number {
  return actor.spawnTick ?? 0;
}

export function isWarbanderAttackTick(actor: WarbanderActor, tick: number): boolean {
  const elapsed = tick - spawnTickOf(actor) - WARBANDER_PROFILES[actor.state.role].attackPhase;
  return elapsed >= 0 && elapsed % WARBAND_ATTACK_PERIOD_TICKS === 0;
}

function nextWarbanderAttackTick(actor: WarbanderActor, tick: number): number {
  const first = spawnTickOf(actor) + WARBANDER_PROFILES[actor.state.role].attackPhase;
  if (tick <= first) return first;
  return first + Math.ceil((tick - first) / WARBAND_ATTACK_PERIOD_TICKS) * WARBAND_ATTACK_PERIOD_TICKS;
}

/** The warband's pursuit; exported so capture conformance replays the production profile. */
export function warbandPursuitProfile(
  slotOffset: Readonly<Coordinate>,
  fallbackOffsets: readonly Readonly<Coordinate>[],
): NpcStickyPursuitProfile {
  return {
    size: 1,
    maxSteps: WARBAND_MAX_STEPS,
    slotOffset,
    fallbackOffsets,
    canOccupy: isArenaFootprintWalkable,
    // UNVERIFIED: never observed with every slot unusable.
    unreachable: 'nearest-adjacent',
  };
}

/**
 * VERIFIED (82/82 captured launches, no attack on any other phase tick): a member attacks on its phase
 * tick when it started the tick on the tile its pursuit selects for the player's start-of-tick tile,
 * one tile straight out, even if a leftover route then carries it away (C:1801). Exported so capture
 * conformance replays the production gate.
 */
export function isWarbanderAttackPosition(
  launch: Readonly<Coordinate>,
  player: Readonly<Coordinate>,
  slotOffset: Readonly<Coordinate>,
  fallbackOffsets: readonly Readonly<Coordinate>[],
): boolean {
  const distance = Math.abs(launch[0] - player[0]) + Math.abs(launch[1] - player[1]);
  return (
    distance === 1 && isAtStickyPursuitDestination(launch, player, warbandPursuitProfile(slotOffset, fallbackOffsets))
  );
}

export const warbanderDefinition = createNpcDefinition<WarbanderState, undefined>({
  id: 'colosseum-warbander',
  /**
   * CAPTURE-FIT, 89/89 warband deaths across the three wave captures (`warbandCapture.test.ts`): a
   * member killed in its own hit pass keeps that tick's turn (B:3356's berserker swings on its killing
   * tick) unless another hit is serviced after the lethal one or a thrall queued one before its turn
   * (C:2142/2432), and its death sequence starts at `max(processTick, lastStepTick + 3)` (B:2210 kill
   * on a still tick, death 2212; B:2218 mid-walk, 2221; B:1882 long still, 1883).
   */
  deathPolicy: 'queued',
  move: ({ actor, context }) => {
    const player = context.world.getPlayer();
    if (
      !canNpcActThisTurn(actor, context.tick) ||
      !player?.alive ||
      context.tick < spawnTickOf(actor) + WARBAND_FIRST_MOVE_TICKS
    )
      return [];
    if (isNpcBound(actor, context.tick)) {
      actor.state.route.remainingSteps = [];
      return [];
    }
    return pursuePlayerSticky(
      actor,
      player.position,
      warbandPursuitProfile(actor.state.slotOffset, actor.state.fallbackOffsets),
      actor.state.route,
    );
  },
  tick: ({ actor, context }) => {
    const none = { environmentalDamages: [] };
    const player = context.world.getPlayer();
    if (!canNpcActThisTurn(actor, context.tick) || !player?.alive || !isWarbanderAttackTick(actor, context.tick))
      return none;
    // Runs after NPC movement and before the player's, so `player.position` is the start-of-tick tile
    // the pursuit used and `previousPosition` is where the member started this tick.
    const launch = actor.previousPosition;
    if (!isWarbanderAttackPosition(launch, player.position, actor.state.slotOffset, actor.state.fallbackOffsets))
      return none;
    const profile = WARBANDER_PROFILES[actor.state.role];
    const { relentless } = actor.state;
    const attack = resolveAttackRequest({
      attacker: actor,
      target: relentless === 0 ? player : withRelentlessDefence(player, relentless),
      plan: relentless === 0 ? profile.plan : withRelentlessPlan(profile.plan, relentless),
      random: context.random,
    });
    if (attack === null) throw new TypeError(`Missing formula stats for ${actor.id}`);
    const { projectile } = profile;
    const impact = projectile?.impact;
    emitEncounterVisual(context.tickEvents, {
      animations: [{ actorId: actor.id, clipId: 'attack', delayCycles: 0 }],
      graphics: impact
        ? [
            {
              spotAnimId: impact.spotAnimId,
              target: { kind: 'attached', actorId: player.id },
              delayCycles: projectile.flight.endDelayCycles,
              height: impact.height,
            },
          ]
        : [],
      projectiles: projectile
        ? [
            {
              ...projectile.flight,
              sourcePosition: npcProjectileSource({ size: actor.size, position: launch }),
              target: actorVisualTarget(player),
            },
          ]
        : [],
    });
    return { environmentalDamages: [], npcAttacks: [attack] };
  },
  onDamageResolved: ({ actor, damage, context }) => {
    if (damage.effectiveDamage < 0 || damage.hpAfter <= 0 || damage.hpAfter > damage.hpBefore) return;
    emitEncounterVisual(context.tickEvents, {
      animations: [{ actorId: actor.id, clipId: 'defend', delayCycles: 0 }],
      projectiles: [],
      graphics: [],
    });
  },
  // Death processing ends its pursuit; the route it was walking goes with it.
  onDeathStarted: ({ actor }) => {
    actor.state.route.remainingSteps = [];
  },
  attackTimer: ({ actor, context }) =>
    canNpcActThisTurn(actor, context.tick)
      ? { nextAttackTick: nextWarbanderAttackTick(actor, context.tick), attackSpeed: WARBAND_ATTACK_PERIOD_TICKS }
      : null,
});

export function createWarbander(input: {
  readonly id: string;
  readonly role: WarbanderRole;
  readonly position: Readonly<Coordinate>;
  readonly spawnTick: number;
  readonly slotOffset: Readonly<Coordinate>;
  readonly fallbackOffsets?: readonly Readonly<Coordinate>[];
  /** The run's Relentless tier; omitted means the modifier is off. */
  readonly relentless?: ColosseumRelentlessRank;
}): WarbanderActor {
  const profile = WARBANDER_PROFILES[input.role];
  const hp = getMonsterHp(profile.npcTypeId);
  const formulaStats = getMonsterFormulaStats(profile.npcTypeId);
  if (hp === undefined || formulaStats === undefined) {
    throw new TypeError(`Missing Colosseum monster data for ${profile.npcTypeId}`);
  }
  const actor: NpcActor = {
    id: input.id,
    kind: 'npc',
    npcTypeId: profile.npcTypeId,
    archetypeId: `colosseum_warband_${input.role}`,
    role: 'minion',
    size: 1,
    alive: true,
    position: [...input.position],
    previousPosition: [...input.position],
    facing: 0,
    spawnTick: input.spawnTick,
    // UNVERIFIED whether others are blocked by them; not blocking keeps Sol's verified pursuit intact.
    blocksNpcMovement: false,
    passThruNpcs: true,
    // VERIFIED: 13 members left the player's tile while it was the player's attack target.
    movesWithAttackerUnder: true,
    // Capture: a member that moves gets a facing reset (B:2203, 2210-2212, 2214-2216) and faces the
    // player's tile once it stops (B:2213, 2217).
    facesStepsWhileMoving: true,
    vitals: { hp, maxHp: hp },
    history: new Map(),
    formulaStats: { ...structuredClone(formulaStats), alwaysMaximumPlayerHitStyles: [profile.weakness] },
    combat: {
      attackSpeed: WARBAND_ATTACK_PERIOD_TICKS,
      attackRange: 1,
      attackStyle: profile.plan.damageType,
      nextActionTick: 0,
      targetId: 'player',
      lastAttackTick: null,
      // Idle and walk come from the cache NpcType (rev 232 has no run seq).
      animations: { idle: null, walk: null, run: null, attack: profile.seqs.attack, death: profile.seqs.death },
    },
  };
  return warbanderDefinition.createActor(actor, {
    role: input.role,
    slotOffset: [...input.slotOffset],
    fallbackOffsets: (input.fallbackOffsets ?? WARBAND_FALLBACK_OFFSETS).map((offset): Coordinate => [...offset]),
    route: createNpcStickyPursuitState(),
    relentless: input.relentless ?? 0,
  });
}
