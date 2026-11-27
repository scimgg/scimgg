import type { NpcActor } from '../../core/actors/NpcActor';
import type { PlayerActor } from '../../core/actors/PlayerActor';
import { enableNpcHitpointRegen } from '../../core/combat/npcRegeneration';
import type { EncounterContext, EnvironmentalDamage, EquipmentClickSlot } from '../../core/encounters/types';
import { type EncounterGraphicCue, emitEncounterVisual } from '../../core/events/encounterVisual';
import { CHAT_HIGHLIGHT_COLORS } from '../../core/events/gameMessages';
import type { OverheadTextSegment } from '../../core/events/types';
import { isNpcMovementSuppressed } from '../../core/npcCombatMovement';
import { createNpcStepOccupancyPredicate } from '../../core/npcOccupancy';
import { isPlayerUnderFootprint, type NpcPursuitProfile, pursuePlayer } from '../../core/npcPursuit';
import { createNpcDefinition, type DefinedNpcActor } from '../../core/npcs';
import { type Coordinate, PrayerType } from '../../types/simulation';
import { createColosseumActor } from './actors';
import {
  clearSolAttacks,
  createSolAttackState,
  launchSolAttack,
  launchSolSpecial,
  readyForcedSpecial,
  type SolAttackPhase,
  type SolAttackState,
  type SolLaunch,
  solAttackReady,
  takeSolGroundLanding,
  takeSolTripleHit,
} from './attackScheduler';
import {
  COLOSSEUM_SPOTANIMS,
  type ColosseumRelentlessRank,
  PERFECT_PARRY_REWARD_TICKS,
  REGULAR_AOE_MAX_HIT,
  RELENTLESS_MAX_HIT_BONUS,
  SOL_CHAT_NAME,
  SOL_SIZE,
  TRIPLE_PRAYER_LOCKOUT_TICKS,
} from './constants';
import {
  GRAPPLE_WRONG_SLOT_MESSAGE,
  grappleOutcomeMessage,
  registerSolParry,
  resolveSolGrapple,
  type SolGrappleState,
  startSolGrapple,
} from './grapple';
import { type ArenaRect, isInsideArena, type SolAttackStyle, telegraphDelayCycles } from './solAttacks';

export interface SolState {
  scheduler: SolAttackState;
  grapple: SolGrappleState;
  immobileUntilTick: number;
  grappleReadyTick: number;
  guaranteedMaxHitUntilTick: number | null;
  /**
   * The run's Relentless tier. Only the triple uses it: the regular AoE's max is unchanged (L), and
   * no capture shows a failed grapple to say whether its damage rises.
   */
  readonly relentless: ColosseumRelentlessRank;
}

export type SolActor = DefinedNpcActor<SolState>;

/** Sent as `spam` with each H-1 prayer drop (L:5149, L:5200). */
const EAGER_PRAYER_MESSAGE: readonly OverheadTextSegment[] = [
  { text: `${SOL_CHAT_NAME} doesn't take kindly to your eager prayer.`, color: CHAT_HIGHLIGHT_COLORS.red },
];

/** Drops every attack in flight so none of them deals damage. A queued practice special stays queued. */
export function cancelSolAttacks(actor: SolActor): void {
  clearSolAttacks(actor.state.scheduler);
  actor.state.grapple.pending = null;
}

export function clearSolAbilities(actor: SolActor): void {
  cancelSolAttacks(actor);
  actor.state.guaranteedMaxHitUntilTick = null;
}

export const solDefinition = createNpcDefinition<SolState, { readonly arena: ArenaRect }>({
  id: 'colosseum-sol-heredit',
  onDefeated: ({ actor }) => clearSolAbilities(actor),
  onDespawn: ({ actor }) => clearSolAbilities(actor),
  move: ({ actor, config, context }) => {
    const target = actor.combat.targetId === null ? undefined : context.world.actors.get(actor.combat.targetId);
    if (
      !actor.alive ||
      !target?.alive ||
      context.world.actors.get(actor.id) !== actor ||
      context.tick < actor.state.immobileUntilTick ||
      isNpcMovementSuppressed(actor, context.world.getPlayer(), context.tick) ||
      (isSolAdjacent(actor.position, target.position) &&
        !isPlayerUnderFootprint(actor.position, SOL_SIZE, target.position))
    )
      return [];
    return pursuePlayer(actor, target.position, context.random, solPursuitProfile(config.arena, context));
  },
  resolveLocalEffects: ({ actor, config, context }) => {
    const player = context.world.getPlayer();
    if (!actor.alive || !player?.alive || actor.combat.targetId !== player.id) {
      clearSolAbilities(actor);
      return [];
    }
    const damages: EnvironmentalDamage[] = [];
    // Regular attacks aim when they land, at the player's start-of-tick tile (analysis section 10).
    const landing = takeSolGroundLanding(actor.state.scheduler, context.tick, {
      position: actor.position,
      target: player.position,
      arena: config.arena,
    });
    if (landing) {
      emitEncounterVisual(context.tickEvents, {
        animations: [],
        projectiles: [],
        graphics: landing.tiles.map((tile, index) => ({
          spotAnimId: COLOSSEUM_SPOTANIMS.solMelee[index % COLOSSEUM_SPOTANIMS.solMelee.length],
          target: { kind: 'tile', position: [tile[0], tile[1]] },
          delayCycles: telegraphDelayCycles(tile, landing.centre),
          height: 0,
        })),
      });
      if (landing.tiles.some(([x, y]) => x === player.position[0] && y === player.position[1])) {
        // MODEL, no accuracy roll: 37/37 start-of-tick exposures hit (L 25, N 4, A 8), none 0.
        // MODEL: the higher of two 0..44 rolls fits their top-heavy spread (mean 29.8, median 33;
        // KS p≈0.89), where a single uniform roll does not (p≈0.002). 5 (L:5538) and 7 (L:4551)
        // rule out a floor near 8.
        const roll = () => Math.floor(context.random() * (REGULAR_AOE_MAX_HIT + 1));
        damages.push({
          baseDamage: Math.max(roll(), roll()),
          attackType: 'typeless',
          source: landing.style === 'spear' ? 'SolSpear' : 'SolShield',
          playerPosition: [...player.position],
        });
      }
    }
    // A:5186/5247: early/held melee protection is dropped on H-1, not only after the hit.
    // More distant early-activation boundaries remain unverified; do not infer an earlier cutoff.
    const pending = actor.state.scheduler.pendingTriple;
    const dueHit = pending.find((hit) => hit.tick === context.tick + 1);
    if (player.activePrayer === PrayerType.ProtectMelee && dueHit) {
      context.setProtectionPrayer?.(null);
      context.tickEvents.emit({ type: 'game_message', kind: 'spam', segments: EAGER_PRAYER_MESSAGE });
      // UNVERIFIED model: once Sol drops the prayer it stays refused through the following hit and
      // is released after it (or after H when H was the last hit). Fits A:5186 (dropped, then
      // A:5193 blocks hit 3) and A:5247-5249 (H retry refused, H+1 allowed once the triple ended).
      // No click timestamps.
      const followingHit = pending.filter((hit) => hit.tick > dueHit.tick).sort((a, b) => a.tick - b.tick)[0];
      context.disableProtectionPrayersUntil?.((followingHit ?? dueHit).tick + 1);
    }
    const hit = takeSolTripleHit(actor.state.scheduler, context.tick);
    const protectedOnLanding =
      player.activePrayer === PrayerType.ProtectMelee &&
      player.prayerState.prayerActivationTicks[PrayerType.ProtectMelee] === context.tick;
    if (hit) {
      // VERIFIED: 25 blocked stabs show zero splats (K:2045, K:2148, K:2225), and L's 97 more.
      // A zero environmental hit uses the engine's block hitsplat without the failed-flick lockout.
      // Unblocked hits are fixed, not rolled: Run A's six unprayed short-triple hits were exactly
      // 15/25/35 twice (A:5148–5154, A:5187–5190, plus A:5248's 35), matching the Wiki's values.
      // Relentless adds its max-hit bonus to each (rank II VERIFIED as +3 by L's 18/28/48).
      damages.push({
        baseDamage: protectedOnLanding ? 0 : hit.damage + RELENTLESS_MAX_HIT_BONUS[actor.state.relentless],
        attackType: 'typeless',
        source: 'SolTripleAttack',
        ...(!protectedOnLanding ? { disablesProtectionPrayersForTicks: TRIPLE_PRAYER_LOCKOUT_TICKS } : {}),
        playerPosition: [...player.position],
      });
    }
    return damages;
  },
});

export function createSol(input: {
  readonly id: string;
  readonly position: Readonly<Coordinate>;
  readonly targetId: string;
  readonly addedTick: number;
  readonly firstAttackTick: number;
  readonly holdUntilTick: number;
  /** The run's Relentless tier; omitted means the modifier is off. */
  readonly relentless?: ColosseumRelentlessRank;
}): SolActor {
  const actor = createColosseumActor('sol', input.id, input.position);
  actor.combat.targetId = input.targetId;
  enableNpcHitpointRegen(actor, input.addedTick);
  return solDefinition.createActor(actor, {
    scheduler: createSolAttackState(input.firstAttackTick),
    grapple: { pending: null },
    immobileUntilTick: input.holdUntilTick,
    grappleReadyTick: 0,
    guaranteedMaxHitUntilTick: null,
    relentless: input.relentless ?? 0,
  });
}

/**
 * Sol paths with the shared Wiki-order breadth-first route (`findNpcMeleeRoute`), taking at most
 * two of its steps per tick. It reproduces every recorded path in all three captures (922 frames),
 * including the diagonal runs and equal-length ties only capture N contains.
 *
 * With the player underneath he steps out one cardinal tile (N:7389 north, N:7754 west), as Yama
 * does; `random-cardinal` fits both but two samples cannot pin the choice. When no route exists he
 * holds, since no capture shows him blocked.
 */
function solPursuitProfile(arena: ArenaRect, context: Pick<EncounterContext, 'world'>): NpcPursuitProfile {
  const canEnterActors = createNpcStepOccupancyPredicate(context.world.occupancy);
  return {
    size: SOL_SIZE,
    maxSpeed: 2,
    canOccupy: ([x, y], size) => {
      for (let dx = 0; dx < size; dx++) {
        for (let dy = 0; dy < size; dy++) if (!isInsideArena([x + dx, y + dy], arena)) return false;
      }
      return true;
    },
    canStep: (current, candidate, size) => canEnterActors(current, candidate, size),
    underFootprint: 'random-cardinal',
    unreachable: 'hold',
  };
}

export function resetSolForPreset(actor: SolActor, firstAttackTick: number): void {
  clearSolAbilities(actor);
  actor.state.scheduler = createSolAttackState(firstAttackTick);
  actor.state.immobileUntilTick = 0;
}

export function consumeSolParryReward(actor: NpcActor, tick: number): boolean {
  const state = solDefinition.getState(actor);
  if (!actor.alive || !state || state.guaranteedMaxHitUntilTick === null || tick > state.guaranteedMaxHitUntilTick)
    return false;
  state.guaranteedMaxHitUntilTick = null;
  return true;
}

function slotHoldsItem(player: PlayerActor, slot: EquipmentClickSlot): boolean {
  if (slot === 'ammo') return player.combatSupplies.equippedAmmo != null;
  if (slot === 'quiver-ammo') return player.combatSupplies.quiverAmmo != null;
  return player.equipment[slot] !== undefined;
}

export function resolveSolParries(actor: SolActor, ctx: EncounterContext, random: () => number): EnvironmentalDamage[] {
  const player = ctx.world.getPlayer();
  if (!actor.alive || !player?.alive || actor.combat.targetId !== player.id) {
    clearSolAbilities(actor);
    return [];
  }
  const target = actor.state.grapple.pending?.target;
  for (const slot of ctx.inputs?.equipmentSlotClicks ?? []) {
    // An empty slot has no item to operate, so its click cannot defend.
    // Wiki (Fortis_Colosseum/Strategies#Sol_Heredit): an empty target slot cannot be defended.
    if (!slotHoldsItem(player, slot)) continue;
    // L:4701: the wrong click's message comes before the correct one's on the same tick.
    if (registerSolParry(actor.state.grapple, slot, ctx.tick) && slot !== target?.slot)
      ctx.tickEvents.emit({ type: 'game_message', kind: 'game', segments: GRAPPLE_WRONG_SLOT_MESSAGE });
  }
  const resolution = resolveSolGrapple(actor.state.grapple, ctx.tick, actor.alive, random);
  if (resolution?.outcome === 'perfect-parry')
    actor.state.guaranteedMaxHitUntilTick = ctx.tick + PERFECT_PARRY_REWARD_TICKS;
  const message = resolution && grappleOutcomeMessage(resolution);
  if (message) ctx.tickEvents.emit({ type: 'game_message', kind: 'game', segments: message });
  return resolution ? [...resolution.damages] : [];
}

/**
 * Whether Sol begins an attack this tick from `start`, his tile when the tick began. The beam
 * warning is keyed to this, so the movement stage asks it before Sol's launch runs.
 */
export function solLaunchesThisTick(
  actor: SolActor,
  ctx: Pick<EncounterContext, 'world' | 'tick'>,
  start: Readonly<Coordinate>,
): boolean {
  const target = actor.combat.targetId === null ? undefined : ctx.world.actors.get(actor.combat.targetId);
  return (
    actor.alive &&
    target?.alive === true &&
    actor.state.grapple.pending === null &&
    solAttackReady(actor.state.scheduler, ctx.tick) &&
    isSolAdjacent(start, target.position)
  );
}

/** Launches Sol's next attack if he is ready and in reach. Returns whether he attacked, and any taunt. */
export function launchSolIfReady(
  actor: SolActor,
  ctx: EncounterContext,
  policy: {
    readonly phase: SolAttackPhase;
    readonly random: () => number;
    /** His own attacks. When false only a queued practice special launches, ahead of any forced spear. */
    readonly enabled: boolean;
    readonly stylePin?: SolAttackStyle;
  },
): { readonly launched: boolean; readonly taunt: string | null } {
  const start = ctx.npcMovements?.get(actor.id)?.from ?? actor.position;
  if (!solLaunchesThisTick(actor, ctx, start)) return { launched: false, taunt: null };
  const scheduler = actor.state.scheduler;
  const input = {
    tick: ctx.tick,
    phase: policy.phase,
    random: policy.random,
    grappleAvailable: ctx.tick >= actor.state.grappleReadyTick,
    stylePin: policy.stylePin,
  };
  let launch: SolLaunch;
  if (policy.enabled) launch = launchSolAttack(scheduler, input);
  else {
    const forced = readyForcedSpecial(scheduler, input.grappleAvailable);
    if (forced === null) return { launched: false, taunt: null };
    launch = launchSolSpecial(scheduler, forced, input);
  }
  // Warning-relative locks, each the only value fitting all 922 K/M/N frames (spear 6, shield 4,
  // grapple 5) and L's (first moves: spear +6 x17, shield +4 x16, grapple +5 x2).
  // A triple does not root him: VERIFIED for the long triple, which chased a player leaving reach on
  // the next tick in 4/4 cases (L:5581->5582, L:5628->5629, L:5191->5194, L:5444->5447). The short
  // triple is UNVERIFIED: no player left reach during one (0/25). +1 is the earliest move a capture
  // can show, since his move runs before the launch in the same tick.
  let movementLock = 1;
  let clipId: string;
  let delayCycles = 0;
  const graphics: EncounterGraphicCue[] = [];
  let taunt: string | null = null;
  switch (launch.kind) {
    case 'regular':
      movementLock = launch.style === 'spear' ? 6 : 4;
      clipId = launch.style;
      break;
    case 'grapple':
      movementLock = 5;
      taunt = startSolGrapple(actor.state.grapple, ctx.tick, policy.random).taunt;
      actor.state.grappleReadyTick = ctx.tick + 1;
      clipId = 'grapple';
      delayCycles = 30;
      break;
    case 'triple':
      clipId = launch.long ? 'triple' : 'tripleShort';
      graphics.push({
        spotAnimId: launch.long ? COLOSSEUM_SPOTANIMS.tripleTelegraphLong : COLOSSEUM_SPOTANIMS.tripleTelegraphShort,
        target: { kind: 'attached', actorId: actor.id },
        delayCycles: 0,
        height: 0,
      });
      break;
    default:
      return assertNever(launch);
  }
  actor.state.immobileUntilTick = Math.max(actor.state.immobileUntilTick, ctx.tick + movementLock);
  emitEncounterVisual(ctx.tickEvents, {
    animations: [{ actorId: actor.id, clipId, delayCycles }],
    projectiles: [],
    graphics,
  });
  return { launched: true, taunt };
}

export function isSolAdjacent(position: Readonly<Coordinate>, target: Readonly<Coordinate>): boolean {
  const withinX = target[0] >= position[0] && target[0] <= position[0] + 4;
  const withinY = target[1] >= position[1] && target[1] <= position[1] + 4;
  return (
    (withinX && withinY) ||
    (withinX && (target[1] === position[1] - 1 || target[1] === position[1] + 5)) ||
    (withinY && (target[0] === position[0] - 1 || target[0] === position[0] + 5))
  );
}

function assertNever(value: never): never {
  throw new TypeError(`Unknown Sol launch: ${JSON.stringify(value)}`);
}
