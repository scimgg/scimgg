import { cloneCombatSupplies } from '../types/encounterLoadout';
import type { GroundItem } from '../types/groundItems';
import type {
  Coordinate,
  DamageHistoryEntry,
  FailCondition,
  NpcAttackTimer,
  NpcRole,
  NpcState,
  PrayerType,
  SimulationEvent,
  SimulationState,
  TickNumber,
} from '../types/simulation';
import type { ActorBase } from './actors/ActorBase';
import type { NpcActor } from './actors/NpcActor';
import type { PlayerActor } from './actors/PlayerActor';
import type { ActorId, DamageType } from './actors/types';
import type { PrayerCheckTiming, SourceDeathPolicy } from './combat/CombatSystem';
import type { EquipmentHitEffectsSnapshot } from './combat/player/equipmentHitEffects';
import type { OnKillEffect, SpecialAttackEffect } from './combat/player/specialAttacks/types';
import type { EncounterOutcome } from './encounters/outcome';
import type { EncounterSnapshot } from './encounters/snapshot';
import type { AttackKind } from './events/types';
import {
  buildPendingPrayerProjection,
  type PendingInputOp,
  type PrayerRestoreProjectionRules,
  projectPendingPrayerInput,
} from './inputOps';
import { TileOccupancy } from './npcOccupancy';

function countPendingOps(player: PlayerActor, type: PendingInputOp['type']): number {
  return player.pendingInputOps.filter((op) => op.type === type).length;
}

/**
 * The encounter damage multipliers as they stood when an attack was LAUNCHED.
 *
 * These became `EncounterDynamic`s — Glyphic Attenuation scales outgoing damage off the
 * player's live prayer bonus — so resolving them again at impact would let gear swapped
 * during a projectile's flight rewrite a roll that was already made. It would also put the
 * damage at odds with the XP drop, which is granted on the attack tick from the launch-time
 * value. An absent snapshot means identity, never "re-resolve now".
 */
export interface PendingHitDamageMultipliers {
  readonly incomingDamageMultiplier: number | undefined;
  readonly outgoingDamageMultiplier: number | undefined;
  readonly specDamageMultiplier: number | undefined;
}

export interface PendingHit {
  /**
   * World-unique, monotonic position in the hit queue, allocated only by
   * `CombatSystem.queuePendingHit`. A victim's due hits apply in this order; `impactTick` decides
   * eligibility, never precedence.
   */
  readonly enqueueSequence: number;
  sourceId: ActorId;
  targetId: ActorId;
  style: DamageType;
  attackKind: AttackKind;
  /** Whether the hit still lands once its source has died or left the world. See {@link SourceDeathPolicy}. */
  readonly sourceDeathPolicy: SourceDeathPolicy;
  /** Tick the attack was launched (projectile created) — distinct from impactTick for two-phase combat */
  launchTick: number;
  /** Tick the damage resolves on the target — may be several ticks after launchTick */
  impactTick: number;
  rolledDamage: number;
  readonly damageCapAtCalculation?: number;
  accuracySucceeded: boolean;
  /**
   * Groups multiple hits from the same multi-hit spec (e.g., dragon claws 4-hit) for presentation
   * only. Each splat is its own entry, so ordering comes from {@link enqueueSequence}, never this.
   */
  attackGroupId?: string;
  onKillEffect?: OnKillEffect;
  postHitEffects?: readonly SpecialAttackEffect[];
  expectedHit?: number;
  sourceSelfDamageRatio?: {
    readonly numerator: number;
    readonly denominator: number;
  };
  applyPoison?: number;
  usingSpecialAttack?: boolean;
  equipmentHitEffects?: EquipmentHitEffectsSnapshot;
  /** When this hit's protection-prayer check is evaluated. Defaults to `'launch'`. */
  prayerCheckAt?: PrayerCheckTiming;
  /** Calculation-time bonus not already included in rolledDamage; never re-derive it at impact. */
  damageBonusPercent?: number;
  /** See {@link PendingHitDamageMultipliers}. Absent means identity. */
  launchDamageMultipliers?: PendingHitDamageMultipliers;
  /**
   * The overhead this hit is judged against, sampled on the tick named by
   * {@link prayerCheckAt}. For the default `'launch'` timing that is the launch tick,
   * which is what lets prayer flicking work: the prayer only has to be up when the
   * attack is made, and switching mid-flight cannot un-protect the player.
   */
  judgedProtectionPrayer?: PrayerType | null;
}

/** What a producer hands the central enqueue; the queue position is allocated there. */
export type PendingHitDraft = Omit<PendingHit, 'enqueueSequence'>;

export interface AreaEffect {
  id: string;
  position: Coordinate;
  radius: number;
  startTick: number;
  endTick: number;
}

export class WorldState {
  tick: number;
  actors: Map<ActorId, ActorBase>;
  /**
   * Append-only in {@link PendingHit.enqueueSequence} order: only `CombatSystem.queuePendingHit`
   * adds entries, and removal never reorders them. Drained per target in TWO passes, one per target
   * owner: NPC-targeted hits resolve in the NPC band before those NPCs move or act, player-targeted
   * hits in the player band after it. Draining both owners in one pass lets a frozen NPC take the
   * impact tick's step and lets an NPC killed by a projectile still swing on the tick it died.
   *
   * The reference-engine evidence for the split is in
   * `docs/architecture/movement-and-facing.md#npc-before-player-tick-phases`; the queue contract is
   * in `docs/architecture/npc-hit-queue-and-death.md`.
   */
  pendingHits: PendingHit[];
  /** Next {@link PendingHit.enqueueSequence}. Never reused within a run. */
  nextHitSequence: number;
  /** Next {@link NpcActor.processingOrder}. Never reused within a run. */
  nextNpcProcessingOrder: number;
  areaEffects: AreaEffect[];
  /** Every pile currently lying on the floor, in drop order. */
  groundItems: GroundItem[];
  /** Monotonic source of {@link GroundItem.id}. Never reused within a run. */
  groundItemSeq: number;
  /**
   * Entity collision flags NPC steps check (`npcOccupancy.ts`): stepped by the engine, updated by
   * `registerNpc` / `removeActor`, reconciled at turn boundaries.
   */
  readonly occupancy: TileOccupancy;

  constructor() {
    this.tick = 0;
    this.actors = new Map();
    this.pendingHits = [];
    this.nextHitSequence = 0;
    this.nextNpcProcessingOrder = 0;
    this.areaEffects = [];
    this.groundItems = [];
    this.groundItemSeq = 0;
    this.occupancy = new TileOccupancy();
  }

  nextGroundItemId(): string {
    this.groundItemSeq += 1;
    return `gi-${this.groundItemSeq}`;
  }

  /**
   * Adds an NPC to the world and gives this registration its {@link NpcActor.processingOrder}.
   * Every engine registration goes through here. Re-registering a previously removed actor
   * object is a new registration and takes a fresh order.
   */
  registerNpc(npc: NpcActor): void {
    // The single writer of the otherwise read-only field.
    (npc as { processingOrder?: number }).processingOrder = this.nextNpcProcessingOrder;
    this.nextNpcProcessingOrder += 1;
    this.actors.set(npc.id, npc);
    this.occupancy.add(npc);
  }

  /** Removes an actor from the world; its collision flags clear now, in removal order. */
  removeActor(id: ActorId): void {
    const actor = this.actors.get(id);
    if (!actor) return;
    this.actors.delete(id);
    this.occupancy.remove(actor);
  }

  getPlayer(): PlayerActor | null {
    for (const actor of this.actors.values()) {
      if (actor.kind === 'player') return actor as PlayerActor;
    }
    return null;
  }

  getPlayers(): PlayerActor[] {
    const players: PlayerActor[] = [];
    for (const actor of this.actors.values()) {
      if (actor.kind === 'player') players.push(actor as PlayerActor);
    }
    return players;
  }

  getNpc(id: ActorId): NpcActor | null {
    const actor = this.actors.get(id);
    if (actor && actor.kind === 'npc') return actor as NpcActor;
    return null;
  }

  getNpcs(): NpcActor[] {
    const npcs: NpcActor[] = [];
    for (const actor of this.actors.values()) {
      if (actor.kind === 'npc') npcs.push(actor as NpcActor);
    }
    return npcs;
  }

  removePendingHitsBySource(sourceId: ActorId): void {
    this.pendingHits = this.pendingHits.filter((hit) => hit.sourceId !== sourceId);
  }
}

export interface EngineSnapshot {
  getFailedCondition(): FailCondition | null;
  getEncounterSnapshot(): EncounterSnapshot;
  getEncounterOutcome(): EncounterOutcome;
  getDamageHistory(): DamageHistoryEntry[];
  getEventLog(): SimulationEvent[];
  getMechanicsConfig(): SimulationState['mechanicsConfig'];
  getNpcHistory(npcId: string): Map<TickNumber, Coordinate>;
  getPlayerAttackCooldown(playerId: string, currentTick: number): number;
  /** Absolute tick the player can next auto-attack (−1 = never attacked). */
  getPlayerNextAttackTick(playerId: string): number;
  /** Effective attack speed in ticks for the current weapon + style. */
  getPlayerAttackSpeed(playerId: string): number;
  /**
   * This NPC's own attack schedule, for definitions that do not drive `combat.nextActionTick`.
   * Null falls back to that generic clock.
   */
  getNpcAttackTimer(npcId: string): NpcAttackTimer | null;
  getIntroActive(): boolean;
  /** See {@link PrayerRestoreProjectionRules}. */
  getPrayerRestoreProjectionRules(): PrayerRestoreProjectionRules;
}

/**
 * The live actor this NPC is fighting, or null when it has no target or that target is
 * dead. A simulation fact; the renderer decides how it affects facing.
 */
function resolveCombatTargetId(world: WorldState, npc: NpcActor): ActorId | null {
  const targetId = npc.combat.targetId;
  if (targetId === null) return null;
  return world.actors.get(targetId)?.alive === true ? targetId : null;
}

/** The target the NPC faces this tick: none while it walks, for an NPC that faces its steps then. */
function resolveFacingTargetId(npc: NpcActor, combatTargetId: ActorId | null): ActorId | null {
  return npc.facesStepsWhileMoving === true && npc.isMoving === true ? null : combatTargetId;
}

/**
 * A definition that schedules its own attacks (Yama's beat pattern, Zuk's cast counter) never
 * advances `combat.nextActionTick`, so asking it first is what keeps those bosses from reading
 * as "never attacks" here.
 */
function resolveAttackTimer(
  npc: NpcActor,
  engineSnapshot: EngineSnapshot,
  combatTargetId: ActorId | null,
): NpcAttackTimer | null {
  const own = engineSnapshot.getNpcAttackTimer(npc.id);
  if (own) return own;
  if (!npc.alive || combatTargetId === null || npc.combat.attackSpeed <= 0 || npc.combat.nextActionTick <= 0)
    return null;
  return { nextAttackTick: npc.combat.nextActionTick, attackSpeed: npc.combat.attackSpeed };
}

export function toSimulationState(world: WorldState, engineSnapshot: EngineSnapshot): SimulationState {
  const player = world.getPlayer();
  const allNpcs = world.getNpcs();
  const primaryNpc = allNpcs.find((npc) => npc.role === 'boss') ?? allNpcs[0] ?? null;

  if (!player) {
    throw new Error('WorldState missing required player actor');
  }

  const orderedNpcs = primaryNpc ? [primaryNpc, ...allNpcs.filter((npc) => npc.id !== primaryNpc.id)] : allNpcs;
  const npcs: NpcState[] = orderedNpcs.map((npc) => {
    const role: NpcRole = npc.role ?? 'npc';
    const combatTargetId = resolveCombatTargetId(world, npc);
    const attackTimer = resolveAttackTimer(npc, engineSnapshot, combatTargetId);
    const crawl = npc.crawlMovement;
    const activeCrawl =
      crawl &&
      world.tick >= crawl.startTick &&
      world.tick < crawl.startTick + 2 &&
      npc.position[0] === crawl.to[0] &&
      npc.position[1] === crawl.to[1];
    return {
      id: npc.id,
      npcTypeId: npc.npcTypeId,
      archetypeId: npc.archetypeId,
      role,
      alive: npc.alive,
      position: npc.position,
      previousPosition: npc.previousPosition,
      ...(npc.movementPath !== undefined && npc.movementPath.length > 1 ? { movementPath: npc.movementPath } : {}),
      ...(activeCrawl
        ? {
            crawlMovement: {
              from: [...crawl.from] as Coordinate,
              to: [...crawl.to] as Coordinate,
              startTick: crawl.startTick,
            },
          }
        : {}),
      facingAngle: npc.facing,
      ...(npc.lockedFacing === undefined ? {} : { lockedFacing: npc.lockedFacing }),
      ...(npc.actionFacing === undefined ? {} : { actionFacing: npc.actionFacing }),
      combatTargetId: resolveFacingTargetId(npc, combatTargetId),
      ...(attackTimer ? { attackTimer } : {}),
      size: npc.size,
      hp: npc.vitals.hp,
      maxHp: npc.vitals.maxHp,
      outline: npc.outline,
      spawnTick: npc.spawnTick,
      despawnTick: npc.despawnTick,
      ...(npc.targetableFromTick === undefined ? {} : { targetableFromTick: npc.targetableFromTick }),
      ...(npc.untargetable ? { untargetable: true } : {}),
      ...(npc.despawnTimerLeadTicks === undefined ? {} : { despawnTimerLeadTicks: npc.despawnTimerLeadTicks }),
      ...(npc.alwaysShowHealthBar ? { alwaysShowHealthBar: true } : {}),
      ...(npc.healthBarWhenUntargetable ? { healthBarWhenUntargetable: true } : {}),
      ...(npc.spawnOrigin === undefined ? {} : { spawnOrigin: npc.spawnOrigin }),
      ...(npc.deathCause === undefined ? {} : { deathCause: npc.deathCause }),
      ...(npc.alive || npc.deathAnimationTick === undefined ? {} : { deathAnimationTick: npc.deathAnimationTick }),
      history: engineSnapshot.getNpcHistory(npc.id),
    };
  });

  const primaryNpcPosition = npcs[0]?.position ?? ([0, 0] as Coordinate);
  const primaryNpcPreviousPosition = npcs[0]?.previousPosition ?? ([0, 0] as Coordinate);
  const primaryNpcFacingAngle = npcs[0]?.facingAngle ?? 0;
  const primaryNpcSize = npcs[0]?.size ?? 1;

  // Predicted from the SAME FIFO walk the engine commits, so a restore dose queued earlier in
  // this tick is visible to a prayer clicked after it. See `projectPendingPrayerInput`.
  const pendingPrayer = projectPendingPrayerInput(
    buildPendingPrayerProjection(player, world.tick, engineSnapshot.getPrayerRestoreProjectionRules()),
  );

  return {
    currentTick: world.tick,
    playerPosition: player.position,
    playerPreviousPosition: player.previousPosition,
    playerMovementPath: player.movementPath,
    playerFacingAngle: player.facing,
    playerIsMoving: player.isMoving,
    playerIsRunning: player.isRunning,
    primaryNpcPosition,
    primaryNpcPreviousPosition,
    primaryNpcFacingAngle,
    primaryNpcSize,
    playerOutline: player.outline,
    npcs,
    encounter: engineSnapshot.getEncounterSnapshot(),
    encounterOutcome: engineSnapshot.getEncounterOutcome(),
    isAlive: player.alive,
    markOfDarknessActive: player.combatTimers.markOfDarknessActiveTicks > 0,
    markOfDarknessTicksRemaining: player.combatTimers.markOfDarknessActiveTicks,
    activePrayer: player.activePrayer,
    offensivePrayer: player.offensivePrayer,
    independentPrayers: player.independentPrayers,
    failedCondition: engineSnapshot.getFailedCondition(),
    playerHistory: player.history,
    primaryNpcHistory: npcs[0]?.history ?? new Map(),
    playerHP: player.vitals.hp,
    maxHP: player.vitals.maxHp,
    poisonVarp: player.poisonState.poisonVarp,
    poisonTickCounter: player.poisonState.poisonTickCounter,
    damageHistory: engineSnapshot.getDamageHistory(),
    eventLog: engineSnapshot.getEventLog(),
    stats: player.stats,
    specialAttack: player.specialAttack,
    ...(player.soulreaper === undefined ? {} : { soulreaperStacks: player.soulreaper.stacks }),
    ...(() => {
      const overload = player.activeEffects?.find((effect) => effect.type === 'overload');
      return overload && overload.ticksRemaining > 0 ? { overloadTicksRemaining: overload.ticksRemaining } : {};
    })(),
    combatTimers: player.combatTimers,
    inventory: player.inventory,
    groundItems: world.groundItems.map((item) => ({ ...item, position: [...item.position] as Coordinate })),
    // Client prediction, exactly like the real client flipping its own prayer and
    // run varbits on click and letting the server confirm: queued inputs are
    // reported as already applied so a second click inside the same tick reads the
    // result of the first instead of repeating it.
    isRunEnabled: countPendingOps(player, 'run_toggle') % 2 === 1 ? !player.isRunEnabled : player.isRunEnabled,
    isSpecialAttackActive: player.isSpecialAttackActive,
    pendingSpecialAttackToggles: countPendingOps(player, 'special_attack_toggle'),
    pendingProtectionPrayer: [pendingPrayer.protectionTouched, pendingPrayer.protection] as [
      boolean,
      PrayerType | null,
    ],
    pendingOffensivePrayer: [pendingPrayer.offensiveTouched, pendingPrayer.offensive] as [boolean, PrayerType | null],
    pendingIndependentPrayers: [pendingPrayer.independentTouched, pendingPrayer.independent] as [
      boolean,
      readonly PrayerType[],
    ],
    quickPrayersActive: pendingPrayer.quickPrayersActive,
    runEnergy: player.runEnergy,
    equipmentStats: player.equipmentStats,
    prayerState: player.prayerState,
    playerEquipment: { ...player.equipment },
    playerCombatSupplies: cloneCombatSupplies(player.combatSupplies),
    cooldownTracks: { ...player.cooldownTracks },
    mechanicsConfig: { ...engineSnapshot.getMechanicsConfig() },
    attackTarget: player.attackTarget,
    lastAttackTarget: player.lastAttackTarget ?? null,
    selectedAttackStyleIndex: player.selectedAttackStyleIndex,
    playerAttackCooldown: engineSnapshot.getPlayerAttackCooldown(player.id, world.tick),
    playerNextAttackTick: engineSnapshot.getPlayerNextAttackTick(player.id),
    playerAttackSpeed: engineSnapshot.getPlayerAttackSpeed(player.id),
    introActive: engineSnapshot.getIntroActive(),
  };
}
