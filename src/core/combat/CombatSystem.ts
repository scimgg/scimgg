import type { Coordinate, PrayerType } from '../../types/simulation';
import { log } from '../../util/Logger';
import type { ActorBase } from '../actors/ActorBase';
import { clearBurnStacks, clearNpcPoison, type NpcActor } from '../actors/NpcActor';
import type { PlayerActor } from '../actors/PlayerActor';
import type { ActorId, DamageType } from '../actors/types';
import type { TickEvents } from '../events/TickEvents';
import type { AttackKind, GameEvent, HitsplatType, RicochetFlight } from '../events/types';
import {
  canNpcActThisTurn,
  canReceiveKillTickSpell,
  canReceiveNewAttack,
  isCurrentActorInstance,
  isNpcDeathReleaseDue,
  isNpcLiving,
  lifeGenerationOf,
  type NpcDeathCauseStage,
  promoteHitQueueDeath,
  recordNpcLethalTransition,
} from '../npcDeath';
import type { PendingHit, PendingHitDamageMultipliers, PendingHitDraft, WorldState } from '../WorldState';
import type { AttackResourceSource } from './attackResources';
import { advanceBurnStacks } from './burnStacks';
import {
  calculatePrayerDamage,
  type DamageValue,
  didPrayCorrectly as didPrayCorrectlyShared,
  resolveDamage,
} from './damageCalculation';
import { applyElysianDamageMitigation, ELYSIAN_SPIRIT_SHIELD_ID } from './elysian';
import { advanceNpcPoison } from './npcPoison';
import { type EquipmentHitEffectsSnapshot, resolveEquipmentHitEffects } from './player/equipmentHitEffects';
import { endPowerOfDeathOnDamage, powerOfDeathMeleeMultiplier } from './player/specialAttacks/instantSpecial';
import { appliesOnAccurateHit, applySpecialAttackEffects } from './player/specialAttacks/postHitEffects';
import type { OnKillEffect, SpecialAttackEffect } from './player/specialAttacks/types';
import { notifyNpcOfPlayerAttack } from './retaliation';

/** No encounter multipliers in force. See {@link PendingHitDamageMultipliers}. */
const IDENTITY_DAMAGE_MULTIPLIERS: PendingHitDamageMultipliers = {
  incomingDamageMultiplier: undefined,
  outgoingDamageMultiplier: undefined,
  specDamageMultiplier: undefined,
};

interface CombatTimersWithAttackSpeed {
  attackSpeed?: number;
}

interface ActorWithCombatTimers {
  combatTimers?: CombatTimersWithAttackSpeed;
}

interface ActorWithActivePrayer {
  activePrayer: PrayerType | null;
}

type TickEventPayload<TType extends GameEvent['type']> = Omit<Extract<GameEvent, { type: TType }>, 'eventId' | 'tick'>;

/**
 * When an attack's protection-prayer check is evaluated.
 *
 * `'launch'` — the OSRS default. The server decides accuracy AND whether the
 * protection prayer blocks at the moment the NPC attacks; the projectile flight is
 * only a visual delay. This is what makes prayer flicking work: the prayer has to be
 * up on the attack tick, and switching away while the projectile is mid-air cannot
 * un-protect you.
 *
 * `{ afterLaunchTicks: n }` — the attack is only RELEASED `n` ticks after its
 * animation, and everything is decided then. JalTok-Jad is the archetype: his clip
 * plays, nothing leaves for three ticks, and the overhead that is up on that third
 * tick is the one that counts — the projectile's remaining flight decides nothing.
 * Clamped to the impact tick.
 *
 * `'impact'` — the prayer is read when the hit lands. Reserve this for mechanics
 * that genuinely resolve late; it lets a switch made after the attack animation
 * retroactively expose the player.
 */
export type PrayerCheckTiming = 'launch' | 'impact' | { readonly afterLaunchTicks: number };

/** OSRS behavior for essentially every NPC attack. */
export const DEFAULT_PRAYER_CHECK_TIMING: PrayerCheckTiming = 'launch';

/**
 * What a queued hit does when its source dies, or leaves the world, before impact
 * (`docs/architecture/npc-hit-queue-and-death.md`, section 4).
 *
 * `'persist'` — the hit was committed when it was released (a projectile, a player attack) and
 * lands regardless, still attributed to the instance that launched it. Inferno 1-68: 1312→1313,
 * a JalMejRah killed on its attack tick still hits for 9.
 *
 * `'cancel-before-impact'` — the hit is still the source's to deliver, so its death (or removal)
 * drops it. The warband berserker's next-tick melee is the observed case (B:3356, no splat at 3357).
 *
 * Classify per attack profile from evidence; never infer it from the damage style.
 */
export type SourceDeathPolicy = 'persist' | 'cancel-before-impact';

export type PrayerReductionType = 'block' | 'cap' | 'reduce' | 'bypass';
export interface PrayerReduction {
  /** For 'cap': maximum damage through prayer. For 'reduce': fraction of damage (0-1) that gets through. */
  value?: number;
  type: PrayerReductionType;
}

export interface AttackResolution {
  style: DamageType;
  attackKind: AttackKind;
  rolledDamage: DamageValue;
  accuracySucceeded: boolean;
  impactDelayTicks: number;
  applyPoison?: number;
  prayerReduction?: PrayerReduction;
  spellId?: string;
  /**
   * Overrides the damage/block splat, e.g. a burn pulse. Honored ONLY on the direct
   * `applyResolvedHit` path that burn pulses take: `resolveAttack` rebuilds its resolution from
   * the bridge result without copying this, and `PendingHit` has no field to carry it, so setting
   * it on an ordinary or delayed attack silently renders as a plain damage splat.
   */
  hitsplatType?: HitsplatType;
  usingSpecialAttack?: boolean;
  onKillEffect?: OnKillEffect;
  postHitEffects?: readonly SpecialAttackEffect[];
  weaponId?: number;
  ammoId?: number;
  ammoSource?: AttackResourceSource;
  expectedHit?: number;
  sourceSelfDamageRatio?: {
    readonly numerator: number;
    readonly denominator: number;
  };
  equipmentHitEffects?: EquipmentHitEffectsSnapshot;
  /** Defaults to {@link DEFAULT_PRAYER_CHECK_TIMING}. */
  prayerCheckAt?: PrayerCheckTiming;
  /**
   * Whole-percent bonus added to an ACCURATE roll (Bloodied Blows' Wretched Strength on
   * Yama). Applied before prayer mitigation, so a protection prayer still reduces the
   * boosted hit; a miss stays 0. It scales the roll rather than flooring it, which is what
   * keeps low rolls low — see `wretchedDamageBonusPercent` in
   * `src/npcs/yama/wretchedStrength.ts` for why the capture requires that.
   */
  damageBonusPercent?: number;
  damageCap?: 'target-hp' | 'none';
  /** Presentation only: the hops a ricocheting shot flies. Their hits are separate requests. */
  ricochets?: readonly RicochetFlight[];
  /**
   * See {@link SourceDeathPolicy}. Production NPC requests always set it (`NpcAttackRequest`
   * requires it). Absent, a player attack persists and an NPC attack cancels, which is how every
   * queued NPC hit behaved before attacks were classified.
   */
  sourceDeathPolicy?: SourceDeathPolicy;
}

export interface DamageAppliedInfo {
  tick: number;
  sourceId: ActorId;
  targetId: ActorId;
  attackType: DamageType;
  baseDamage: number;
  effectiveDamage: number;
  activePrayer: PrayerType | null;
  prayedCorrectly: boolean | null;
  hpBefore: number;
  hpAfter: number;
  applyPoison?: number;
  /** Present only on the hit that took the target from above 0 HP to 0. */
  onKillEffect?: OnKillEffect;
  expectedHit?: number;
  /**
   * The launching NPC's type, read off the instance that queued the hit, so a hit that lands after
   * its source was pruned (or its id reused) is still attributed to what fired it.
   */
  sourceNpcTypeId?: number;
}

export interface CombatBridge {
  events: TickEvents;
  infiniteHealth?: boolean;
  enablePendingHits?: boolean;
  incomingDamageMultiplier?: number;
  outgoingDamageMultiplier?: number;
  specDamageMultiplier?: number;
  resolveTargetHitDamage?(
    target: Readonly<NpcActor>,
    style: DamageType,
    attackKind: AttackKind,
    damage: number,
    accurate: boolean,
  ): {
    readonly damage: number;
    readonly invertToHeal?: boolean;
    readonly blockStatDrains?: boolean;
  };
  getAttackSpeed?(attacker: ActorBase): number;
  resolveAttack?(world: WorldState, attacker: ActorBase, target: ActorBase): Partial<AttackResolution>;
  onDamageApplied?(info: DamageAppliedInfo): void;
  /**
   * A hit that cost the ATTACKER hitpoints (the ruby bolt proc). Separate from
   * `onDamageApplied`, which reports damage to the target: this is the player's own HP loss, on a
   * different actor, and the engine reacts to it (Redemption procs from it).
   */
  onSourceSelfDamageApplied?(): void;
  onAttackStarted?(): void;
}

export interface CombatSystemOptions {
  enablePendingHits?: boolean;
  defaultAttackSpeedTicks?: number;
  /**
   * The engine's seeded combat stream. Left at `Math.random` a run cannot be reconstructed,
   * so replay takeover resumes a fight that rolled different damage than the one on screen.
   */
  random?: () => number;
}

export interface PrevalidatedAttackRequest {
  readonly attacker: ActorBase;
  readonly target: ActorBase;
  readonly attack: AttackResolution;
}

interface CommitAttackOptions {
  readonly emitAttackStarted: boolean;
  /** Deliver through the target's hit queue even with no flight time (see {@link CombatSystem.queueHitRequest}). */
  readonly queueImmediateHit?: boolean;
}

/**
 * The actor instances a queued hit was launched between. Kept off {@link PendingHit} so the queue
 * stays plain data; a hit whose source or target id now names a different instance (or none) is
 * discarded rather than landing on a stranger.
 */
export interface PendingHitRuntime {
  readonly source: ActorBase;
  readonly target: ActorBase;
  readonly prayerReduction?: PrayerReduction;
}

/** {@link PendingHitRuntime} plus the lives it was queued against; a revival starts a new one. */
interface QueuedHitRuntime extends PendingHitRuntime {
  readonly sourceLife: number;
  readonly targetLife: number;
}

export class CombatSystem {
  private readonly nextAttackTickByActor = new Map<ActorId, number>();
  /**
   * Cycle length (in ticks) that was used to schedule the current cooldown.
   * This is the `attackSpeed` value in effect at the moment `canAttack()` ran,
   * *not* the current effective speed — the metronome UI needs the former so
   * the fill ratio stays stable when the player swaps weapons mid-cooldown.
   * `speedUpNextAttack()` (perfect dodge) also trims this for the current
   * window so the metronome completes exactly when the shortened cooldown ends.
   */
  private readonly scheduledAttackCycleByActor = new Map<ActorId, number>();
  /**
   * Total "next-attack speedup" (in ticks) already shaved off the CURRENT
   * cooldown window for an actor (Yama Mark-of-Darkness perfect dodge). Used to
   * clamp repeated dodges so they do NOT stack within a single cooldown window.
   * Reset when `canAttack()` schedules the next cooldown.
   */
  private readonly appliedAttackSpeedupByActor = new Map<ActorId, number>();
  private pendingHitRuntime = new WeakMap<PendingHit, QueuedHitRuntime>();
  private readonly enablePendingHits: boolean;
  private readonly defaultAttackSpeedTicks: number;
  private readonly random: () => number;

  constructor(options: CombatSystemOptions = {}) {
    this.enablePendingHits = options.enablePendingHits ?? false;
    this.defaultAttackSpeedTicks = Math.max(1, Math.floor(options.defaultAttackSpeedTicks ?? 1));
    // Wrapped rather than aliased: capturing `Math.random` itself freezes the reference at
    // construction, so a later reassignment of it (a test spy) would never be seen.
    this.random = options.random ?? ((): number => Math.random());
  }

  reset(): void {
    this.nextAttackTickByActor.clear();
    this.scheduledAttackCycleByActor.clear();
    this.appliedAttackSpeedupByActor.clear();
    this.pendingHitRuntime = new WeakMap<PendingHit, QueuedHitRuntime>();
  }

  getNextAttackTick(actorId: ActorId): number | undefined {
    return this.nextAttackTickByActor.get(actorId);
  }

  /**
   * Shortens the attacker's remaining attack delay by `reduction` ticks — Purging staff's
   * *Scatter ashes* on-kill refund, the only caller — under three invariants:
   *
   * 1. A reduction that reaches `currentTick` defers the swing to `currentTick + 1`. In OSRS
   *    the follow-up attack is not available on the tick the reduction is processed: "the 3
   *    tick reduction is processed too late for the player to attack 2 ticks later", which is
   *    why a 5-tick weapon reads as an effective 3 (wiki, Purging staff § Special attack).
   *    This engine resolves queued hits BEFORE the auto-attack band, so without this floor the
   *    player swings on the kill tick and the staff runs a tick fast on every kill.
   * 2. Above that floor the subtraction is exact, which is what keeps the wiki's control case
   *    true: spec, then eat (+3 delay), and the next attack comes 5 ticks later (5 + 3 - 3),
   *    not 3 or 6.
   * 3. A reduction never DELAYS. For an actor already past its cooldown — a hit whose impact
   *    delay outran the weapon's own speed lands on a tick where it may swing — raising the
   *    tick to the floor would be a delay dressed up as a refund, so `Math.min` leaves it be.
   */
  reduceNextAttackTick(actorId: ActorId, reduction: number, currentTick: number): void {
    const current = this.nextAttackTickByActor.get(actorId);
    if (current === undefined || reduction <= 0) return;
    const earliestActionableTick = currentTick + 1;
    this.nextAttackTickByActor.set(actorId, Math.min(current, Math.max(earliestActionableTick, current - reduction)));
  }

  /**
   * Extends the attacker's next-attack tick by `delayTicks`, but ONLY if a
   * weapon cooldown is currently active (i.e. `currentTick < nextAttackTick`).
   *
   * Models the OSRS food-eat rule:
   *   "Foods only add to an existing attack delay between weapon attacks. If
   *    your weapon is ready to attack again then eating does not add any new delay."
   *   — https://oldschool.runescape.wiki/w/Food/Fast_foods
   *
   * Stacks additively with other calls in the same tick, so combo-eating a shark
   * (3) and a karambwan (2) results in a total +5 tick attack delay (matching the
   * wiki's "shark + karambwan = 5 tick attack delay" example).
   */
  extendNextAttackTickIfActive(actorId: ActorId, currentTick: number, delayTicks: number): void {
    if (delayTicks <= 0) return;
    const current = this.nextAttackTickByActor.get(actorId);
    if (current === undefined) return;
    if (currentTick < current) {
      this.nextAttackTickByActor.set(actorId, current + delayTicks);
    }
  }

  getScheduledAttackCycle(actorId: ActorId): number | undefined {
    return this.scheduledAttackCycleByActor.get(actorId);
  }

  /**
   * Speed up an actor's NEXT attack by up to `ticks` (Yama Mark-of-Darkness
   * perfect dodge). Shortens the CURRENTLY pending cooldown so the next swing
   * lands sooner — matching the OSRS wiki ("their next attack will be used one
   * tick faster than usual"). Clamped per cooldown window so repeated dodges
   * before the next swing do NOT stack, never shortens the cycle below 1 tick,
   * and never pulls the next attack earlier than `currentTick` (you cannot
   * attack in the past). A no-op when no cooldown is ACTIVE — before the first
   * swing, or when the actor is already eligible to attack — because there is
   * then no pending delay to shave (matching OSRS, where attackDelay is 0).
   */
  speedUpNextAttack(actorId: ActorId, ticks: number, currentTick: number): void {
    if (ticks <= 0) return;
    const nextTick = this.nextAttackTickByActor.get(actorId);
    if (nextTick === undefined || nextTick <= currentTick) {
      log.info(
        'PerfectDodge',
        `(${actorId}) no active attack cooldown at tick ${currentTick} — speedup not applicable`,
      );
      return;
    }
    const alreadyApplied = this.appliedAttackSpeedupByActor.get(actorId) ?? 0;
    const cycle = this.scheduledAttackCycleByActor.get(actorId) ?? this.defaultAttackSpeedTicks;
    // Clamp the reduction so that: (a) the total speedup for THIS cooldown
    // window never exceeds `ticks` (no stacking across dodges), (b) the cycle is
    // never shortened below 1 tick, and (c) the next attack is never pulled
    // earlier than the current tick.
    const applied = Math.min(ticks - alreadyApplied, Math.max(0, cycle - 1), nextTick - currentTick);
    if (applied <= 0) {
      log.info(
        'PerfectDodge',
        `(${actorId}) speedup already applied this cooldown (no stacking) — next attack stays at tick ${nextTick}`,
      );
      return;
    }
    const newNextTick = nextTick - applied;
    this.nextAttackTickByActor.set(actorId, newNextTick);
    this.scheduledAttackCycleByActor.set(actorId, cycle - applied);
    this.appliedAttackSpeedupByActor.set(actorId, alreadyApplied + applied);
    log.info(
      'PerfectDodge',
      `⚡ ${actorId} next attack sped up by ${applied} tick(s): cooldown now ends at tick ` +
        `${newNextTick} instead of ${nextTick} (cycle ${cycle} -> ${cycle - applied}).`,
    );
  }

  getAppliedAttackSpeedup(actorId: ActorId): number {
    return this.appliedAttackSpeedupByActor.get(actorId) ?? 0;
  }

  /**
   * `acceptKillTickTarget`: the player's manual cast, which may still start on an NPC whose death is
   * not yet processed (`canReceiveKillTickSpell`). Queuing it never moves that death earlier: the
   * hit-queue promotion only looks at the pass that killed it.
   */
  processAttack(
    world: WorldState,
    attacker: ActorBase,
    target: ActorBase,
    bridge: CombatBridge,
    options: { readonly acceptKillTickTarget?: boolean } = {},
  ): boolean {
    const targetAccepts = options.acceptKillTickTarget === true ? canReceiveKillTickSpell : canReceiveNewAttack;
    if (!this.canAttackerAct(world, attacker) || !targetAccepts(target)) {
      return false;
    }

    const currentTick = world.tick;
    if (!this.canAttack(currentTick, attacker, bridge)) {
      return false;
    }

    return this.commitAttack(
      world,
      { attacker, target, attack: this.resolveAttack(world, attacker, target, bridge) },
      bridge,
    );
  }

  processAttackRequest(world: WorldState, request: PrevalidatedAttackRequest, bridge: CombatBridge): boolean {
    if (!this.canAttackerAct(world, request.attacker) || !canReceiveNewAttack(request.target)) {
      return false;
    }

    return this.commitAttack(world, request, bridge);
  }

  /**
   * A further hit of an attack that was already accepted: another component of a multi-hit batch, or
   * the release of an attack whose animation already played. An earlier component killing the target
   * does not reject the rest of the batch (spec section 4): on an NPC already at 0 HP it lands as a
   * zero impact. A dead player, or an NPC removed from life by anything other than damage, still
   * refuses it.
   */
  processSupplementalHitRequest(world: WorldState, request: PrevalidatedAttackRequest, bridge: CombatBridge): boolean {
    if (!this.canAttackerAct(world, request.attacker) || !this.canReceiveAcceptedHit(request.target)) {
      return false;
    }

    return this.commitAttack(world, request, bridge, { emitAttackStarted: false });
  }

  /**
   * The launch of an attack a dying NPC committed to before its death, on its death-animation tick
   * (`isNpcDeathReleaseDue`). The only path that accepts a dying source; the target must still accept
   * a new attack, and the hit then follows its own `sourceDeathPolicy` like any other.
   */
  processDeathReleaseRequest(world: WorldState, request: PrevalidatedAttackRequest, bridge: CombatBridge): boolean {
    const { attacker } = request;
    if (
      !this.isNpcActor(attacker) ||
      !isNpcDeathReleaseDue(attacker, world.tick) ||
      !canReceiveNewAttack(request.target)
    )
      return false;
    return this.commitAttack(world, request, bridge);
  }

  /**
   * A hit from outside the attacker's own action (a structure's collapse, a scripted blast): no attack
   * event, delivered through the target's hit queue at `launch + impactDelayTicks`. A zero-delay hit
   * lands on the target's own turn, this tick if that is still to come and otherwise the next, as the
   * queue orders any other hit.
   */
  queueHitRequest(world: WorldState, request: PrevalidatedAttackRequest, bridge: CombatBridge): boolean {
    if (!this.canAttackerAct(world, request.attacker) || !canReceiveNewAttack(request.target)) return false;
    return this.commitAttack(
      world,
      request,
      { ...bridge, enablePendingHits: true },
      {
        emitAttackStarted: false,
        queueImmediateHit: true,
      },
    );
  }

  private commitAttack(
    world: WorldState,
    request: PrevalidatedAttackRequest,
    bridge: CombatBridge,
    options: CommitAttackOptions = { emitAttackStarted: true },
  ): boolean {
    const { attacker, target } = request;
    const npcPlayerHit = attacker.kind === 'npc' && target.kind === 'player';
    const damageCapAtCalculation = npcPlayerHit && request.attack.damageCap !== 'none' ? target.vitals.hp : undefined;
    let attack = request.attack;
    if (npcPlayerHit) {
      const roll = this.normalizeNonNegativeInt(resolveDamage(attack.rolledDamage, this.random));
      const baseDamage = attack.accuracySucceeded ? roll : 0;
      const boostedDamage = baseDamage + Math.floor((baseDamage * (attack.damageBonusPercent ?? 0)) / 100);
      const scaledDamage = Math.max(0, Math.floor(boostedDamage * (bridge.incomingDamageMultiplier ?? 1)));
      attack = {
        ...attack,
        rolledDamage: scaledDamage,
        damageBonusPercent: undefined,
      };
    }
    const damageBridge = npcPlayerHit ? { ...bridge, incomingDamageMultiplier: undefined } : bridge;
    const currentTick = world.tick;
    bridge.events.setTick(currentTick);
    if (options.emitAttackStarted) {
      const attackStartedEvent: TickEventPayload<'attack_started'> = {
        type: 'attack_started',
        sourceId: attacker.id,
        targetId: target.id,
        style: attack.style,
        attackKind: attack.attackKind,
        spellId: attack.spellId,
        // A powered staff casts its built-in spell with no spellId, and a ranged shot's arrival (the
        // Scorching bow special's impact sounds) is timed by the same geometry as a spell's.
        ...(attack.spellId === undefined && !(attacker.kind === 'player' && attack.style !== 'melee')
          ? {}
          : {
              spellCast: {
                sourcePosition: [attacker.position[0], attacker.position[1]],
                targetPosition: [target.position[0], target.position[1]],
                targetSize: target.size,
                accurate: attack.accuracySucceeded,
              },
            }),
        usingSpecialAttack: attack.usingSpecialAttack,
        impactDelayTicks: attack.impactDelayTicks,
        weaponId: attack.weaponId,
        ammoId: attack.ammoId,
        ammoSource: attack.ammoSource,
        ...(attack.ricochets === undefined ? {} : { ricochets: attack.ricochets }),
      };
      bridge.events.emit(attackStartedEvent);
      bridge.onAttackStarted?.();
    } else if (attacker.kind === 'player' && attack.spellId !== undefined) {
      const spellTargetEvent: TickEventPayload<'spell_targeted'> = {
        type: 'spell_targeted',
        sourceId: attacker.id,
        targetId: target.id,
        spellId: attack.spellId,
        spellCast: {
          sourcePosition: [attacker.position[0], attacker.position[1]],
          targetPosition: [target.position[0], target.position[1]],
          targetSize: target.size,
          accurate: attack.accuracySucceeded,
        },
        impactDelayTicks: attack.impactDelayTicks,
        weaponId: attack.weaponId,
      };
      bridge.events.emit(spellTargetEvent);
    }
    attack = this.applyFreezeAtLaunch(attacker, target, attack, currentTick);

    const shouldQueueDelayedHit =
      this.isPendingHitEnabled(bridge) && (attack.impactDelayTicks > 0 || options.queueImmediateHit === true);
    const targetNpc = attacker.kind === 'player' ? world.getNpc(target.id) : null;
    if (targetNpc) {
      notifyNpcOfPlayerAttack(targetNpc, {
        sourceId: attacker.id,
        launchTick: currentTick,
        impactTick: currentTick + (shouldQueueDelayedHit ? attack.impactDelayTicks : 0),
        style: attack.style,
        accuracySucceeded: attack.accuracySucceeded,
      });
    }
    if (shouldQueueDelayedHit) {
      // Drawn on every swing and only then discarded, NOT inside the ternary below.
      // `this.random` is the shared combat stream the player's own rolls come off, so a
      // draw taken only on a hit lets an attacker's accuracy outcome shift every later
      // roll in the fight — the coupling `YamaSimulationState.run.accuracyRng` exists to
      // avoid, reintroduced one layer down. The undelayed path in `applyResolvedHit`
      // already draws unconditionally; these two must stay on the same sequence.
      const damageRoll = resolveDamage(attack.rolledDamage, this.random);
      const pendingHit: PendingHitDraft = {
        sourceId: attacker.id,
        targetId: target.id,
        style: attack.style,
        attackKind: attack.attackKind,
        launchTick: currentTick,
        impactTick: currentTick + attack.impactDelayTicks,
        rolledDamage: attack.accuracySucceeded ? damageRoll : 0,
        damageCapAtCalculation,
        accuracySucceeded: attack.accuracySucceeded,
        damageBonusPercent: attack.damageBonusPercent,
        prayerCheckAt: attack.prayerCheckAt ?? DEFAULT_PRAYER_CHECK_TIMING,
        // Seeded with the launch-tick overhead; a hit whose check tick falls later
        // overwrites this when that tick comes around, in `processPendingHits`.
        judgedProtectionPrayer: this.getActivePrayer(target),
        applyPoison: attack.applyPoison,
        usingSpecialAttack: attack.usingSpecialAttack,
        onKillEffect: attack.onKillEffect,
        postHitEffects: attack.postHitEffects,
        expectedHit: attack.expectedHit,
        sourceSelfDamageRatio: attack.sourceSelfDamageRatio,
        launchDamageMultipliers: {
          incomingDamageMultiplier: damageBridge.incomingDamageMultiplier,
          outgoingDamageMultiplier: bridge.outgoingDamageMultiplier,
          specDamageMultiplier: bridge.specDamageMultiplier,
        },
        equipmentHitEffects: attack.equipmentHitEffects,
        sourceDeathPolicy:
          attack.sourceDeathPolicy ?? (attacker.kind === 'player' ? 'persist' : 'cancel-before-impact'),
      };
      this.queuePendingHit(world, pendingHit, { source: attacker, target, prayerReduction: attack.prayerReduction });
      return true;
    }

    // A source killed earlier this tick still swings at the player on the turn its queued death allows,
    // but the hit, still its own to deliver to the player, lands nothing (as a queued one is dropped at
    // impact): no melee swing on the player on an NPC's killing tick shows a splat (Inferno P t959 and
    // 8 more Jal-ImKot, Q t47 Jal-Xil, P t864 / Q t413 Jal-AkRek-Ket; Colosseum B:3356 warband). A swing
    // at another NPC still lands: 15/15 Jal-Nib swings on their killing tick damage the pillar (P t1503).
    if (
      this.isNpcActor(attacker) &&
      !attacker.alive &&
      target.kind === 'player' &&
      (attack.sourceDeathPolicy ?? 'cancel-before-impact') === 'cancel-before-impact'
    )
      return true;
    this.applyResolvedHit(world, attacker, target, attack, damageBridge, undefined, damageCapAtCalculation);
    return true;
  }

  /**
   * A player's freeze (Ice spells, Zamorak godsword) takes hold when the attack is cast, not when it
   * lands: the target's next step is the first one lost, while the spell is still in the air. Every
   * Ice Burst / Barrage target moving on its cast tick in the captures (269) stops the tick after,
   * e.g. inferno-waves-1-68 t581 cast, nibblers still from t582, splats t586. A miss freezes nothing
   * (a splashed Burst walks on: inferno-waves-1-68 t3517). The freeze is therefore applied here, on
   * the accuracy decided at launch, and dropped from the effects the hit carries to impact.
   */
  private applyFreezeAtLaunch(
    attacker: ActorBase,
    target: ActorBase,
    attack: AttackResolution,
    launchTick: number,
  ): AttackResolution {
    const effects = attack.postHitEffects;
    if (!effects?.some((effect) => effect.effect === 'freeze')) return attack;
    // A kill-tick cast (phantom barrage) still rolls and heals, but the dying NPC takes no freeze.
    if (attack.accuracySucceeded && this.isPlayerActor(attacker) && this.isNpcActor(target) && isNpcLiving(target)) {
      applySpecialAttackEffects(
        attacker,
        target,
        0,
        effects.filter((effect) => effect.effect === 'freeze'),
        launchTick,
      );
    }
    const carried = effects.filter((effect) => effect.effect !== 'freeze');
    return { ...attack, postHitEffects: carried.length > 0 ? carried : undefined };
  }

  /**
   * The only way into {@link WorldState.pendingHits}: allocates the hit's queue position and binds it
   * to the actor instances it was launched between. Multi-hit attacks enqueue one entry per splat,
   * in the order they should land.
   */
  queuePendingHit(world: WorldState, draft: PendingHitDraft, runtime: PendingHitRuntime): PendingHit {
    if (runtime.source.id !== draft.sourceId || runtime.target.id !== draft.targetId) {
      throw new Error(
        `queuePendingHit: runtime ${runtime.source.id}->${runtime.target.id} does not match hit ` +
          `${draft.sourceId}->${draft.targetId}`,
      );
    }
    const pendingHit: PendingHit = { ...draft, enqueueSequence: world.nextHitSequence };
    world.nextHitSequence += 1;
    this.pendingHitRuntime.set(pendingHit, {
      ...runtime,
      sourceLife: lifeGenerationOf(runtime.source),
      targetLife: lifeGenerationOf(runtime.target),
    });
    world.pendingHits.push(pendingHit);
    return pendingHit;
  }

  /**
   * One band's queue pass: drains every target of `targetKind` (all targets when omitted) through
   * {@link processPendingHitsForTarget}, visiting targets in the order of their oldest queued hit.
   * Ordering is only guaranteed within a victim. See {@link WorldState.pendingHits} for why there
   * are two bands.
   */
  processPendingHits(world: WorldState, bridge: CombatBridge, targetKind?: ActorBase['kind']): void {
    if (world.pendingHits.length === 0) {
      return;
    }

    // An entry whose target has been removed or replaced, or whose cancelable source has, is never
    // serviced. Swept here, before any callback runs, because a removed target is never visited by a
    // per-target drain.
    world.pendingHits = world.pendingHits.filter((pendingHit) => this.isStillDeliverable(world, pendingHit));

    const drained = new Set<ActorBase>();
    for (;;) {
      const target = this.nextTargetToDrain(world, targetKind, drained);
      if (target === null) return;
      drained.add(target);
      this.processPendingHitsForTarget(world, bridge, target);
    }
  }

  /**
   * Services one victim's queue in {@link PendingHit.enqueueSequence} order. A due entry is claimed
   * (removed) before its callbacks run; a hit queued for this victim during the drain is serviced
   * in turn if it is already due. Each entry is visited at most once, and entries not yet due stay
   * queued. The queue is re-read on every step, never restored from a snapshot, so insertions and
   * removals made by callbacks survive.
   *
   * A due hit is delivered by the source INSTANCE that queued it, alive or not, when its
   * {@link SourceDeathPolicy} is `'persist'`; a `'cancel-before-impact'` hit needs that instance
   * still registered and alive. An NPC victim already at 0 HP takes it as a zero impact.
   *
   * An NPC this pass kills has its death processing promoted from K+1 to K when another accepted hit
   * is serviced after the lethal one, or is still queued for it when the pass ends — work that
   * existed before or arose during this pass, never later (`promoteHitQueueDeath`).
   */
  processPendingHitsForTarget(world: WorldState, bridge: CombatBridge, target: ActorBase): void {
    const npc = this.isNpcActor(target) ? target : null;
    const deathBeforePass = npc?.death;
    let killedThisPass = false;
    let servicedAfterKill = false;
    let lastVisitedSequence = Number.NEGATIVE_INFINITY;
    for (;;) {
      // A target removed or replaced by a callback loses the rest of its drain; the next pass's
      // sweep discards whatever it left queued.
      if (!isCurrentActorInstance(world, target)) break;
      const pendingHit = this.nextQueuedHitForTarget(world, target.id, lastVisitedSequence);
      if (pendingHit === null) break;
      lastVisitedSequence = pendingHit.enqueueSequence;

      const runtime = this.requirePendingHitRuntime(pendingHit);
      if (runtime.target !== target || !this.isStillDeliverable(world, pendingHit)) {
        this.removeQueuedHit(world, pendingHit);
        continue;
      }
      // Sample the overhead on this hit's OWN check tick, wherever that falls. The engine
      // applied this tick's queued prayer switch before combat ran, so a swap the player
      // made on the previous tick is live here — the same relationship the reference gets
      // by flushing queued input at the top of a tick (`Input.onWorldTick`) and firing an
      // attack's `DelayedAction` at the bottom of it (`World.tickRegion`).
      if (this.prayerCheckTick(pendingHit) === world.tick) {
        pendingHit.judgedProtectionPrayer = this.getActivePrayer(target);
      }

      if (pendingHit.impactTick > world.tick) {
        continue;
      }

      this.removeQueuedHit(world, pendingHit);
      if (!this.canReceiveAcceptedHit(target)) continue;
      if (pendingHit.sourceDeathPolicy === 'cancel-before-impact' && !runtime.source.alive) continue;

      this.applyResolvedHit(
        world,
        runtime.source,
        target,
        {
          style: pendingHit.style,
          attackKind: pendingHit.attackKind,
          rolledDamage: pendingHit.rolledDamage,
          accuracySucceeded: pendingHit.accuracySucceeded,
          impactDelayTicks: Math.max(0, pendingHit.impactTick - pendingHit.launchTick),
          damageBonusPercent: pendingHit.damageBonusPercent,
          applyPoison: pendingHit.applyPoison,
          prayerReduction: runtime.prayerReduction,
          usingSpecialAttack: pendingHit.usingSpecialAttack,
          onKillEffect: pendingHit.onKillEffect,
          postHitEffects: pendingHit.postHitEffects,
          expectedHit: pendingHit.expectedHit,
          sourceSelfDamageRatio: pendingHit.sourceSelfDamageRatio,
          equipmentHitEffects: pendingHit.equipmentHitEffects,
          prayerCheckAt: pendingHit.prayerCheckAt,
        },
        // The multipliers are the LAUNCH tick's, not this bridge's — see
        // {@link PendingHitDamageMultipliers}. Spreading `{}` would silently leave the
        // impact-time values in place, so all three are always written.
        { ...bridge, ...(pendingHit.launchDamageMultipliers ?? IDENTITY_DAMAGE_MULTIPLIERS) },
        pendingHit.judgedProtectionPrayer,
        pendingHit.damageCapAtCalculation,
      );
      if (npc === null) continue;
      if (killedThisPass) servicedAfterKill = true;
      else if (npc.death !== undefined && npc.death !== deathBeforePass) killedThisPass = true;
    }
    if (npc !== null && killedThisPass && (servicedAfterKill || this.hasAcceptedHitQueuedFor(world, npc))) {
      promoteHitQueueDeath(npc, world.tick);
    }
  }

  /** A hit still queued for this victim that will be serviced: deliverable, and not canceled by its source. */
  private hasAcceptedHitQueuedFor(world: WorldState, target: NpcActor): boolean {
    return world.pendingHits.some((pendingHit) => {
      if (pendingHit.targetId !== target.id || !this.isStillDeliverable(world, pendingHit)) return false;
      const runtime = this.requirePendingHitRuntime(pendingHit);
      return pendingHit.sourceDeathPolicy === 'persist' || runtime.source.alive;
    });
  }

  private requirePendingHitRuntime(pendingHit: PendingHit): QueuedHitRuntime {
    const runtime = this.pendingHitRuntime.get(pendingHit);
    if (runtime === undefined) {
      throw new Error(
        `pending hit #${pendingHit.enqueueSequence} (${pendingHit.sourceId}->${pendingHit.targetId}) ` +
          'was not queued through this CombatSystem.queuePendingHit',
      );
    }
    return runtime;
  }

  /**
   * The victim must still be the instance the hit was queued against. So must the source, unless the
   * hit persists past its source's death or removal — and then the retained instance delivers it, never
   * a newer actor that took the same id.
   */
  private isStillDeliverable(world: WorldState, pendingHit: PendingHit): boolean {
    const runtime = this.requirePendingHitRuntime(pendingHit);
    if (runtime.target !== world.actors.get(pendingHit.targetId)) return false;
    if (lifeGenerationOf(runtime.target) !== runtime.targetLife) return false;
    if (pendingHit.sourceDeathPolicy === 'persist') return true;
    return (
      runtime.source === world.actors.get(pendingHit.sourceId) &&
      lifeGenerationOf(runtime.source) === runtime.sourceLife
    );
  }

  /**
   * Whether an already accepted hit still lands on `target`. A live target takes it normally; an NPC
   * killed by damage (at 0 HP, its corpse not yet pruned) takes it as a zero impact. A dead player,
   * whose run is over, and an NPC taken out of life some other way at nonzero HP take nothing.
   */
  private canReceiveAcceptedHit(target: ActorBase): boolean {
    return target.alive || (this.isNpcActor(target) && target.death !== undefined && target.vitals.hp === 0);
  }

  /** An NPC killed earlier this tick may still take the turn its death record allows (`npcDeath.ts`). */
  private canAttackerAct(world: WorldState, attacker: ActorBase): boolean {
    return this.isNpcActor(attacker) ? canNpcActThisTurn(attacker, world.tick) : attacker.alive;
  }

  /** The current target of the oldest queued hit not yet drained in this pass, if it is of `kind`. */
  private nextTargetToDrain(
    world: WorldState,
    kind: ActorBase['kind'] | undefined,
    drained: ReadonlySet<ActorBase>,
  ): ActorBase | null {
    for (const pendingHit of world.pendingHits) {
      const target = world.actors.get(pendingHit.targetId);
      if (target === undefined || drained.has(target)) continue;
      if (kind !== undefined && target.kind !== kind) continue;
      return target;
    }
    return null;
  }

  /** The lowest-sequence hit queued for `targetId` after `afterSequence`. */
  private nextQueuedHitForTarget(world: WorldState, targetId: ActorId, afterSequence: number): PendingHit | null {
    let next: PendingHit | null = null;
    for (const pendingHit of world.pendingHits) {
      if (pendingHit.targetId !== targetId || pendingHit.enqueueSequence <= afterSequence) continue;
      if (next === null || pendingHit.enqueueSequence < next.enqueueSequence) next = pendingHit;
    }
    return next;
  }

  private removeQueuedHit(world: WorldState, pendingHit: PendingHit): void {
    const index = world.pendingHits.indexOf(pendingHit);
    if (index !== -1) world.pendingHits.splice(index, 1);
  }

  /**
   * Tick this NPC's burn clock, in its turn. One splat per pulse, valued at the number of stacks
   * burning — "each time the entity will take damage equal to the number of burn stacks they
   * currently have" (/w/Burn). The captures agree: `hit id=74` carries values 1 to 5, never a
   * row of 1s.
   *
   * `typeless`, though /w/Burn calls burn damage ranged-coded, because that coding only exists
   * there to feed an NPC's damage-style reductions, which this sim does not model. Typing it
   * `ranged` here would instead reach `calculateDamage`'s prayer path, and "the Protect from
   * Missiles prayer will not reduce burn damage".
   */
  processBurnStacks(world: WorldState, bridge: CombatBridge, target: NpcActor): void {
    bridge.events.setTick(world.tick);
    const pulse = advanceBurnStacks(target, world.tick);
    if (pulse === null) return;
    const source = world.actors.get(pulse.sourceId);
    if (source === undefined) return;
    this.applyResolvedHit(
      world,
      source,
      target,
      {
        style: 'typeless',
        attackKind: 'typeless',
        rolledDamage: pulse.stackCount,
        accuracySucceeded: true,
        impactDelayTicks: 0,
        hitsplatType: 'burn',
      },
      bridge,
      undefined,
      undefined,
      'fixed',
    );
    if (!target.alive) clearBurnStacks(target);
  }

  /**
   * Tick this NPC's poison clock, mirroring {@link processBurnStacks}: one splat per pulse, valued
   * off the severity that pulse spends.
   *
   * `typeless` and `'fixed'` for the same reasons burn is — the pulse is a flat, already-decided
   * number that must not be re-rolled, and must not reach `calculateDamage`'s prayer path.
   */
  processNpcPoison(world: WorldState, bridge: CombatBridge, target: NpcActor): void {
    bridge.events.setTick(world.tick);
    const pulse = advanceNpcPoison(target, world.tick);
    if (pulse === null) return;
    const source = world.actors.get(pulse.sourceId);
    if (source === undefined) return;
    this.applyResolvedHit(
      world,
      source,
      target,
      {
        style: 'typeless',
        attackKind: 'typeless',
        rolledDamage: pulse.damage,
        accuracySucceeded: true,
        impactDelayTicks: 0,
        hitsplatType: 'poison',
      },
      bridge,
      undefined,
      undefined,
      'fixed',
    );
    if (!target.alive) clearNpcPoison(target);
  }

  /**
   * Absolute tick a pending hit's protection-prayer check runs on. A release-delayed
   * check can never outlive the hit itself, so it is clamped to the impact tick.
   */
  private prayerCheckTick(pendingHit: PendingHit): number {
    const timing = pendingHit.prayerCheckAt ?? DEFAULT_PRAYER_CHECK_TIMING;
    if (timing === 'launch') return pendingHit.launchTick;
    if (timing === 'impact') return pendingHit.impactTick;
    return Math.min(pendingHit.impactTick, pendingHit.launchTick + timing.afterLaunchTicks);
  }

  private canAttack(currentTick: number, attacker: ActorBase, bridge: CombatBridge): boolean {
    const nextAllowedTick = this.nextAttackTickByActor.get(attacker.id) ?? Number.NEGATIVE_INFINITY;
    if (currentTick < nextAllowedTick) {
      return false;
    }

    const attackSpeed = this.getAttackSpeed(attacker, bridge);

    const effectiveCycle = Math.max(1, attackSpeed);
    this.nextAttackTickByActor.set(attacker.id, currentTick + effectiveCycle);
    this.scheduledAttackCycleByActor.set(attacker.id, effectiveCycle);
    this.appliedAttackSpeedupByActor.delete(attacker.id);
    return true;
  }

  private resolveAttack(
    world: WorldState,
    attacker: ActorBase,
    target: ActorBase,
    bridge: CombatBridge,
  ): AttackResolution {
    const style = this.defaultStyleForAttacker(attacker);
    const baseAttack: AttackResolution = {
      style,
      attackKind: this.defaultAttackKindForStyle(style),
      rolledDamage: 0,
      accuracySucceeded: true,
      impactDelayTicks: 0,
    };

    const override = bridge.resolveAttack?.(world, attacker, target);
    if (!override) {
      return baseAttack;
    }

    return {
      style: override.style ?? baseAttack.style,
      attackKind: override.attackKind ?? baseAttack.attackKind,
      rolledDamage: override.rolledDamage ?? baseAttack.rolledDamage,
      accuracySucceeded: override.accuracySucceeded ?? baseAttack.accuracySucceeded,
      impactDelayTicks: this.normalizeNonNegativeInt(override.impactDelayTicks ?? baseAttack.impactDelayTicks),
      applyPoison: override.applyPoison,
      prayerReduction: override.prayerReduction ?? baseAttack.prayerReduction,
      spellId: override.spellId ?? baseAttack.spellId,
      usingSpecialAttack: override.usingSpecialAttack ?? baseAttack.usingSpecialAttack,
      onKillEffect: override.onKillEffect,
      postHitEffects: override.postHitEffects,
      weaponId: override.weaponId,
      ammoId: override.ammoId,
      ammoSource: override.ammoSource,
      expectedHit: override.expectedHit,
      sourceSelfDamageRatio: override.sourceSelfDamageRatio,
      equipmentHitEffects: override.equipmentHitEffects,
      prayerCheckAt: override.prayerCheckAt ?? baseAttack.prayerCheckAt,
      damageBonusPercent: override.damageBonusPercent,
      damageCap: override.damageCap,
      ricochets: override.ricochets,
      sourceDeathPolicy: override.sourceDeathPolicy,
    };
  }

  private applyResolvedHit(
    world: WorldState,
    source: ActorBase,
    target: ActorBase,
    attack: AttackResolution,
    bridge: CombatBridge,
    /**
     * Prayer to judge this hit against. Omit to read the target's live prayer, which
     * is right for an undelayed hit (launch and impact are the same tick).
     */
    activePrayerOverride?: PrayerType | null,
    damageCapAtCalculation?: number,
    damageMode: 'standard' | 'fixed' = 'standard',
  ): void {
    if (!target.alive) {
      this.applyZeroImpact(world, source, target, attack, bridge);
      return;
    }
    // Project Rebalance (May 2024): a successful PLAYER accuracy roll boosts a
    // rolled 0 to 1 damage. This is a player OFFENSIVE rule only — NPC attacks
    // roll 0..max and a rolled 0 must stay 0 so prayer mitigation (cap/reduce/
    // block) can produce a true 0-damage (fully blocked) hit. Forcing NPC 0→1
    // made prayed-against attacks (e.g. Yama P3 range/mage) always deal ≥1, so
    // they could never land a 0 and would leave the player stuck at 1 HP.
    const resolved = this.normalizeNonNegativeInt(resolveDamage(attack.rolledDamage, this.random));
    const minDamageOnHit = source.kind === 'player' ? 1 : 0;
    let baseDamage = attack.accuracySucceeded ? Math.max(minDamageOnHit, resolved) : 0;
    if (attack.damageBonusPercent) {
      baseDamage += Math.floor((baseDamage * attack.damageBonusPercent) / 100);
    }
    if (damageMode === 'standard' && bridge.outgoingDamageMultiplier !== undefined && source.kind === 'player') {
      baseDamage = Math.max(0, Math.floor(baseDamage * bridge.outgoingDamageMultiplier));
    }
    if (
      damageMode === 'standard' &&
      bridge.specDamageMultiplier !== undefined &&
      attack.usingSpecialAttack &&
      source.kind === 'player'
    ) {
      baseDamage = Math.max(0, Math.floor(baseDamage * bridge.specDamageMultiplier));
    }

    let blockStatDrains = false;
    if (
      damageMode === 'standard' &&
      source.kind === 'player' &&
      this.isNpcActor(target) &&
      bridge.resolveTargetHitDamage
    ) {
      const targetHit = bridge.resolveTargetHitDamage(
        target,
        attack.style,
        attack.attackKind,
        baseDamage,
        attack.accuracySucceeded,
      );
      blockStatDrains = targetHit.blockStatDrains === true;
      if (targetHit.invertToHeal === true) {
        const healAmount = Math.max(0, Math.floor(targetHit.damage));
        const hpBefore = target.vitals.hp;
        if (healAmount > 0) {
          target.vitals.hp = Math.min(target.vitals.maxHp, hpBefore + healAmount);
        }
        bridge.events.setTick(world.tick);
        bridge.events.emit({
          type: 'hit_applied',
          targetId: target.id,
          targetPosition: [...target.position] as Coordinate,
          damage: 0,
          blocked: true,
          attackKind: attack.attackKind,
          prayedCorrectly: null,
          accurate: attack.accuracySucceeded,
        });
        bridge.events.emit({
          type: 'hitsplat_spawned',
          targetId: target.id,
          amount: healAmount,
          hitsplatType: healAmount > 0 ? 'heal' : 'block',
        });
        bridge.onDamageApplied?.({
          tick: world.tick,
          sourceId: source.id,
          targetId: target.id,
          attackType: attack.style,
          baseDamage: 0,
          effectiveDamage: 0,
          activePrayer: null,
          prayedCorrectly: null,
          hpBefore,
          hpAfter: target.vitals.hp,
          expectedHit: attack.expectedHit,
        });
        return;
      }
      baseDamage = Math.max(0, Math.floor(targetHit.damage));
    }
    const damageApplied = this.applyDamage(
      source,
      target,
      baseDamage,
      attack.style,
      world.tick,
      bridge,
      attack.prayerReduction,
      // Poison rides on a swing that CONNECTED. Yama's melee is the only carrier and it
      // attaches the varp to every swing, so ungating this poisons the player off a miss —
      // a blue 0 splat that applies venom. Deliberately keyed to accuracy and not to
      // `effectiveDamage`, which an overhead can zero on a hit that did land.
      attack.accuracySucceeded ? attack.applyPoison : undefined,
      attack.onKillEffect,
      attack.expectedHit,
      activePrayerOverride,
      damageCapAtCalculation,
      // A burn or poison pulse is a timer kill: death processing at K+1, never promoted.
      attack.hitsplatType === 'burn' || attack.hitsplatType === 'poison' ? 'timer' : 'hit-queue',
    );

    // Emit the hit's own events before `onDamageApplied`, so a callback-generated splat (Redemption
    // heals the player from inside it) follows the hit that triggered it.
    bridge.events.setTick(world.tick);
    const hitAppliedEvent: TickEventPayload<'hit_applied'> = {
      type: 'hit_applied',
      targetId: target.id,
      targetPosition: [...target.position] as Coordinate,
      damage: damageApplied.effectiveDamage,
      blocked: damageApplied.effectiveDamage === 0,
      attackKind: attack.attackKind,
      prayedCorrectly: damageApplied.prayedCorrectly,
      accurate: attack.accuracySucceeded,
    };
    bridge.events.emit(hitAppliedEvent);

    const hitsplatEvent: TickEventPayload<'hitsplat_spawned'> = {
      type: 'hitsplat_spawned',
      targetId: target.id,
      amount: damageApplied.effectiveDamage,
      hitsplatType: attack.hitsplatType ?? (damageApplied.effectiveDamage > 0 ? 'damage' : 'block'),
    };
    bridge.events.emit(hitsplatEvent);

    bridge.onDamageApplied?.(damageApplied);

    if (attack.postHitEffects && this.isPlayerActor(source) && this.isNpcActor(target)) {
      // A hit that CONNECTED is not the same as one that dealt damage: the player's minimum-1 rule
      // runs before `outgoingDamageMultiplier`, so a damping encounter can floor a landed hit to 0.
      // Shadow's drain and Ice's freeze key off the hit landing; everything else, Smoke's poison
      // included, still wants real damage. See {@link appliesOnAccurateHit}.
      const rawEligible =
        damageApplied.effectiveDamage > 0
          ? attack.postHitEffects
          : attack.accuracySucceeded
            ? attack.postHitEffects.filter(appliesOnAccurateHit)
            : [];
      const eligible = blockStatDrains
        ? rawEligible.filter(
            (effect) =>
              effect.effect !== 'drain_defence' &&
              effect.effect !== 'drain_magic' &&
              effect.effect !== 'drain_attack' &&
              effect.effect !== 'weaken' &&
              effect.effect !== 'condemn',
          )
        : rawEligible;
      if (eligible.length > 0) {
        applySpecialAttackEffects(source, target, damageApplied.effectiveDamage, eligible, world.tick);
      }
    }
    if (attack.equipmentHitEffects && this.isPlayerActor(source) && this.isNpcActor(target)) {
      resolveEquipmentHitEffects({
        snapshot: attack.equipmentHitEffects,
        accurate: attack.accuracySucceeded,
        target,
        sourceId: source.id,
        impactTick: world.tick,
        roll: this.random,
      });
    }

    if (attack.accuracySucceeded && attack.sourceSelfDamageRatio !== undefined && this.isPlayerActor(source)) {
      const ratio = attack.sourceSelfDamageRatio;
      const selfDamage = Math.min(
        source.vitals.hp - 1,
        Math.floor((source.vitals.hp * ratio.numerator) / ratio.denominator),
      );
      if (selfDamage > 0) {
        endPowerOfDeathOnDamage(source, selfDamage);
        source.vitals.hp -= selfDamage;
        source.stats.hitpoints.current = source.vitals.hp;
        bridge.events.emit({
          type: 'hitsplat_spawned',
          targetId: source.id,
          amount: selfDamage,
          hitsplatType: 'damage',
        });
        // After the splat, so a Redemption heal splat renders second. The 1-HP floor above means
        // this can never kill, so there is no death check to run first.
        bridge.onSourceSelfDamageApplied?.();
      }
    }

    // Only the hit that took the target to 0 reports its death; every later one is a zero impact.
    if (!target.alive) {
      const actorDiedEvent: TickEventPayload<'actor_died'> = {
        type: 'actor_died',
        actorId: target.id,
      };
      bridge.events.emit(actorDiedEvent);
    }
  }

  /**
   * An accepted hit landing on an NPC that is already at 0 HP (Inferno 1-68: 7288→7289; the C:1606
   * scythe's `45,0,0`): it shows as a 0 block splat in queue order and is reported, so damage
   * attribution stays complete, but it rolls nothing and has no further effect — no procs, no
   * freeze, poison, burn, drain, heal or self-damage, and no second death, defeat or kill reward.
   */
  private applyZeroImpact(
    world: WorldState,
    source: ActorBase,
    target: ActorBase,
    attack: AttackResolution,
    bridge: CombatBridge,
  ): void {
    const activePrayer = this.getActivePrayer(target);
    const prayedCorrectly = attack.style === 'typeless' ? null : this.didPrayCorrectly(attack.style, activePrayer);
    bridge.events.setTick(world.tick);
    bridge.events.emit({
      type: 'hit_applied',
      targetId: target.id,
      targetPosition: [...target.position] as Coordinate,
      damage: 0,
      blocked: true,
      attackKind: attack.attackKind,
      prayedCorrectly,
      accurate: attack.accuracySucceeded,
    } satisfies TickEventPayload<'hit_applied'>);
    bridge.events.emit({
      type: 'hitsplat_spawned',
      targetId: target.id,
      amount: 0,
      hitsplatType: 'block',
    } satisfies TickEventPayload<'hitsplat_spawned'>);
    bridge.onDamageApplied?.({
      tick: world.tick,
      sourceId: source.id,
      targetId: target.id,
      attackType: attack.style,
      baseDamage: 0,
      effectiveDamage: 0,
      activePrayer,
      prayedCorrectly,
      hpBefore: target.vitals.hp,
      hpAfter: target.vitals.hp,
      expectedHit: attack.expectedHit,
      ...(this.isNpcActor(source) ? { sourceNpcTypeId: source.npcTypeId } : {}),
    });
  }

  private getAttackSpeed(attacker: ActorBase, bridge: CombatBridge): number {
    const fromBridge = bridge.getAttackSpeed?.(attacker);
    if (typeof fromBridge === 'number' && fromBridge > 0) {
      return Math.floor(fromBridge);
    }

    if (this.isNpcActor(attacker)) {
      return Math.max(1, Math.floor(attacker.combat.attackSpeed));
    }

    const timers = (attacker as ActorWithCombatTimers).combatTimers;
    if (timers && typeof timers.attackSpeed === 'number' && timers.attackSpeed > 0) {
      return Math.floor(timers.attackSpeed);
    }

    return this.defaultAttackSpeedTicks;
  }

  private isPendingHitEnabled(bridge: CombatBridge): boolean {
    if (typeof bridge.enablePendingHits === 'boolean') {
      return bridge.enablePendingHits;
    }
    return this.enablePendingHits;
  }

  private defaultStyleForAttacker(attacker: ActorBase): DamageType {
    if (this.isNpcActor(attacker)) {
      return attacker.combat.attackStyle;
    }
    return 'melee';
  }

  private defaultAttackKindForStyle(style: DamageType): AttackKind {
    if (style === 'magic') return 'magic_fire';
    if (style === 'range') return 'range_arrow';
    if (style === 'melee') return 'melee_crush';
    return 'magic_shadow';
  }

  private getActivePrayer(actor: ActorBase): PrayerType | null {
    if (this.hasActivePrayer(actor)) {
      return actor.activePrayer;
    }
    return null;
  }

  private normalizeNonNegativeInt(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.floor(value));
  }

  private calculateDamage(
    baseDamage: number,
    attackType?: DamageType,
    activePrayer?: PrayerType | null,
    prayerReduction?: PrayerReduction,
  ): number {
    return calculatePrayerDamage(baseDamage, attackType, activePrayer, prayerReduction);
  }

  private applyDamage(
    source: ActorBase,
    target: ActorBase,
    baseDamage: number,
    attackType: DamageType,
    tick: number,
    bridge: CombatBridge,
    prayerReduction?: PrayerReduction,
    applyPoison?: number,
    onKillEffect?: OnKillEffect,
    expectedHit?: number,
    activePrayerOverride?: PrayerType | null,
    damageCapAtCalculation?: number,
    lethalCause: NpcDeathCauseStage = 'hit-queue',
  ): DamageAppliedInfo {
    const hpBefore = target.vitals.hp;
    const activePrayer = activePrayerOverride !== undefined ? activePrayerOverride : this.getActivePrayer(target);
    // /w/Staff_of_the_dead#Special_attack. Resolve at impact, before prayer and shield reductions;
    // NPC encounter multipliers have already been snapshotted at launch.
    if (this.isPlayerActor(target) && attackType === 'melee') {
      baseDamage = Math.floor(baseDamage * powerOfDeathMeleeMultiplier(target, tick));
    }
    if (bridge.incomingDamageMultiplier !== undefined && target.kind === 'player') {
      baseDamage = Math.max(0, Math.floor(baseDamage * bridge.incomingDamageMultiplier));
    }
    const prayerAdjustedDamage = this.calculateDamage(baseDamage, attackType, activePrayer, prayerReduction);
    const cappedDamage =
      damageCapAtCalculation === undefined
        ? prayerAdjustedDamage
        : Math.min(prayerAdjustedDamage, damageCapAtCalculation);
    const mitigatedDamage =
      cappedDamage > 0 &&
      this.isNpcActor(source) &&
      this.isPlayerActor(target) &&
      target.equipment.shield === ELYSIAN_SPIRIT_SHIELD_ID
        ? applyElysianDamageMitigation(cappedDamage, this.random())
        : cappedDamage;
    // A hit on an NPC deals and shows at most its remaining HP: Colosseum captures, every player
    // hit on a 1-HP Bee swarm splats 1 (17/17), and no Fremennik warbander's splats exceed its HP (30/30).
    const effectiveDamage = this.isNpcActor(target)
      ? Math.min(mitigatedDamage, Math.max(0, hpBefore))
      : mitigatedDamage;

    const isProtected = bridge.infiniteHealth && target.kind === 'player';
    if (!isProtected && this.isPlayerActor(target)) {
      endPowerOfDeathOnDamage(target, effectiveDamage);
    }
    if (!isProtected) {
      target.vitals.hp -= effectiveDamage;
      if (target.vitals.hp < 0) {
        target.vitals.hp = 0;
      }
    }

    const prayedCorrectly = attackType === 'typeless' ? null : this.didPrayCorrectly(attackType, activePrayer);

    if (!isProtected && target.vitals.hp <= 0) {
      // The NPC's one lethal transition: its death record, and `alive=false` as the projection of it.
      if (this.isNpcActor(target)) recordNpcLethalTransition(target, tick, lethalCause);
      else target.alive = false;
    }

    const info: DamageAppliedInfo = {
      tick,
      sourceId: source.id,
      targetId: target.id,
      attackType,
      baseDamage,
      effectiveDamage,
      activePrayer,
      prayedCorrectly,
      hpBefore,
      hpAfter: target.vitals.hp,
      applyPoison,
      onKillEffect: hpBefore > 0 && !target.alive ? onKillEffect : undefined,
      expectedHit,
      ...(this.isNpcActor(source) ? { sourceNpcTypeId: source.npcTypeId } : {}),
    };
    return info;
  }

  private didPrayCorrectly(attackType: 'magic' | 'range' | 'melee', activePrayer: PrayerType | null): boolean {
    return didPrayCorrectlyShared(attackType, activePrayer);
  }

  private isNpcActor(actor: ActorBase): actor is NpcActor {
    return actor.kind === 'npc';
  }

  private isPlayerActor(actor: ActorBase): actor is PlayerActor {
    return actor.kind === 'player';
  }

  private hasActivePrayer(actor: ActorBase): actor is ActorBase & ActorWithActivePrayer {
    return 'activePrayer' in actor;
  }
}
