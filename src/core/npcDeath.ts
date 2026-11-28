import type { TickNumber } from '../types/simulation';
import type { ActorBase } from './actors/ActorBase';
import { clearBurnStacks, clearNpcPoison, type NpcActor } from './actors/NpcActor';
import type { WorldState } from './WorldState';

/**
 * NPC life state and deferred death: `docs/architecture/npc-hit-queue-and-death.md`, section 3.
 *
 * `alive` is the compatibility projection — false from the first transition to 0 HP. The death
 * record says what that death still allows: a `queued` NPC killed in its hit-queue pass keeps the
 * turn it was killed on unless death processing has already started.
 */

/**
 * `immediate`: death processing starts on the lethal transition (bosses and scripted adds: Sol, Yama,
 * Zuk, the glyph, crystals, Solarflare, Bees, totems). `queued`: it starts at `processTick` — K+1, or K
 * when the hit queue promotes it (the warband, Zuk's sets, Jad and both healer families, void flares).
 */
export type NpcDeathPolicy = 'immediate' | 'queued';

/** What killed the NPC: a hit (queued or direct), a burn/poison pulse, or encounter script. */
export type NpcDeathCauseStage = 'hit-queue' | 'timer' | 'scripted';

export interface NpcDeathRecord {
  status: 'pending' | 'started';
  /** K: the tick of the lethal transition. Rewards and the defeat notification are anchored here. */
  readonly killTick: TickNumber;
  /** When death processing runs. Never later than K+1, and only the hit queue moves it to K. */
  processTick: TickNumber;
  readonly causeStage: NpcDeathCauseStage;
  /** Set once the definition has been told the death animation started (`claimNpcDeathAnimation`). */
  animationNotified?: true;
}

/**
 * OBSERVED for ordinary NPCs (every warband death, Inferno ranger 3590, B:2210): the death
 * animation starts at `max(processTick, lastStepTick + 3)`.
 */
export const DEATH_ANIMATION_AFTER_STEP_TICKS = 3;

export function npcDeathPolicy(npc: Pick<NpcActor, 'deathPolicy'>): NpcDeathPolicy {
  return npc.deathPolicy ?? 'immediate';
}

/** The instance registered under its id; a replacement with the same id is a different actor. */
export function isCurrentActorInstance(world: Pick<WorldState, 'actors'>, actor: ActorBase): boolean {
  return world.actors.get(actor.id) === actor;
}

/**
 * Whether this NPC still gets its ordinary turn (movement, actions) on `tick`: alive, or a pending
 * death whose processing comes later. Never more than the turn it was killed on.
 */
export function canNpcActThisTurn(npc: NpcActor, tick: TickNumber): boolean {
  if (npc.alive) return true;
  const death = npc.death;
  return death !== undefined && death.status === 'pending' && tick < death.processTick;
}

/** No new attack is started against an actor that has died, pending or not. */
export function canReceiveNewAttack(actor: ActorBase): boolean {
  return actor.alive && (actor.kind !== 'npc' || (actor as NpcActor).death === undefined);
}

/**
 * OBSERVED (inferno-waves-(35ish)-to-68 t1214→t1219): on its kill tick, before death processing,
 * an NPC at 0 HP still takes a manually cast spell and an Ancient Burst/Barrage's area. Every other
 * new attack is refused ({@link canReceiveNewAttack}). The hit lands later as a zero impact.
 * `docs/architecture/npc-hit-queue-and-death.md`, "Phantom barrage".
 */
export function canReceiveKillTickSpell(actor: ActorBase): boolean {
  return canReceiveNewAttack(actor) || (actor.kind === 'npc' && (actor as NpcActor).death?.status === 'pending');
}

/**
 * Neither dead nor dying. Strict life, for what a dying NPC must not do even on the turn its death
 * record still allows (heal, retaliate) and what must not be done to it.
 */
export function isNpcLiving(npc: NpcActor): boolean {
  return npc.alive && npc.death === undefined;
}

/** Healing and regeneration stop on the first transition to 0 HP. */
export function canReceiveHealing(npc: NpcActor): boolean {
  return isNpcLiving(npc);
}

export function lifeGenerationOf(actor: ActorBase): number {
  return actor.kind === 'npc' ? ((actor as NpcActor).lifeGeneration ?? 0) : 0;
}

export function queuedDeathAnimationTick(processTick: TickNumber, lastStepTick: TickNumber | undefined): TickNumber {
  return lastStepTick === undefined
    ? processTick
    : Math.max(processTick, lastStepTick + DEATH_ANIMATION_AFTER_STEP_TICKS);
}

/**
 * The first transition to 0 HP, exactly once per life: projects `alive=false`, creates the death
 * record, and stops the NPC's timers. Accepted incoming hits stay queued (they land as zero
 * impacts). Death processing is separate — {@link startNpcDeath}.
 *
 * A timer kill always processes at K+1 and is never promoted. A scripted kill processes at once.
 */
export function recordNpcLethalTransition(
  npc: NpcActor,
  killTick: TickNumber,
  causeStage: NpcDeathCauseStage,
): NpcDeathRecord {
  if (npc.death !== undefined) throw new Error(`NPC '${npc.id}' already has a death record for this life`);
  const deferred = npcDeathPolicy(npc) === 'queued' && causeStage !== 'scripted';
  const death: NpcDeathRecord = {
    status: 'pending',
    killTick,
    processTick: deferred ? killTick + 1 : killTick,
    causeStage,
  };
  npc.death = death;
  npc.alive = false;
  delete npc.deathAnimationTick;
  // Cleared here, not at processing: a due hit that kills first leaves no pulse to run, and the
  // boss-HP tool can revive an NPC before the next burn or poison pulse.
  clearBurnStacks(npc);
  clearNpcPoison(npc);
  refreshQueuedDeathAnimationTick(npc);
  return death;
}

/**
 * The hit-queue rule: an NPC killed in its own queue pass processes death on K, not K+1, when
 * another accepted hit is serviced after the lethal one or is still pending when the pass ends.
 */
export function promoteHitQueueDeath(npc: NpcActor, tick: TickNumber): void {
  const death = npc.death;
  if (death?.status !== 'pending' || death.causeStage !== 'hit-queue' || death.killTick !== tick) return;
  if (death.processTick <= tick) return;
  death.processTick = tick;
  refreshQueuedDeathAnimationTick(npc);
}

/**
 * A queued NPC whose death has been processed and whose death animation has started by `tick`, its
 * definition not yet told (`claimNpcDeathAnimation`).
 */
export function isNpcDeathAnimationDue(npc: NpcActor, tick: TickNumber): boolean {
  return (
    npc.death?.status === 'started' &&
    npc.death.animationNotified !== true &&
    npcDeathPolicy(npc) === 'queued' &&
    npc.deathAnimationTick !== undefined &&
    npc.deathAnimationTick <= tick
  );
}

/**
 * True exactly once per life, at the first chance once a queued NPC's death animation is due: the one
 * gate for its `onDeathAnimation`, whether the engine's turn or a scripted death's processing reaches it
 * first. A scripted death adjudicated after its tick (the boss-HP tool) is told when it is processed.
 */
export function claimNpcDeathAnimation(npc: NpcActor, tick: TickNumber): boolean {
  const death = npc.death;
  if (death === undefined || !isNpcDeathAnimationDue(npc, tick)) return false;
  death.animationNotified = true;
  return true;
}

/**
 * The one tick a dying NPC may still LAUNCH an attack it committed to before dying (a windup scheduled to
 * release now): its death animation's own tick, for a death the hit queue or a timer caused. It never
 * starts a new attack (`canNpcActThisTurn` stays false); a scripted death releases nothing.
 */
export function isNpcDeathReleaseDue(npc: NpcActor, tick: TickNumber): boolean {
  return npc.death?.status === 'started' && npc.death.causeStage !== 'scripted' && npc.deathAnimationTick === tick;
}

/**
 * The kill turn a promoted death took away: a `queued` NPC whose death processing started on its own kill
 * tick (the hit queue's promotion) gets no ordinary turn on it, unlike a pending one. An attack it had already
 * committed to that falls due on that turn still launches (`Encounter.releaseNpcKillTurn`); nothing new
 * starts, and a scripted death releases nothing. Separate from the death-animation release, which the
 * last-step floor can put ticks later.
 */
export function isNpcKillTurnReleaseDue(npc: NpcActor, tick: TickNumber): boolean {
  const death = npc.death;
  return (
    death?.status === 'started' &&
    death.causeStage !== 'scripted' &&
    death.killTick === tick &&
    npcDeathPolicy(npc) === 'queued'
  );
}

/** When a dying NPC may launch an attack it committed to before dying; each has its own gate. */
export type NpcDeathReleaseTiming = 'kill-turn' | 'death-animation';

export function isNpcDeathReleaseDueAt(npc: NpcActor, tick: TickNumber, timing: NpcDeathReleaseTiming): boolean {
  return timing === 'kill-turn' ? isNpcKillTurnReleaseDue(npc, tick) : isNpcDeathReleaseDue(npc, tick);
}

export function isNpcDeathDue(npc: NpcActor, tick: TickNumber): boolean {
  return npc.death?.status === 'pending' && npc.death.processTick <= tick;
}

/**
 * Death processing: ends ordinary movement and interaction for good and clears retaliation. The
 * corpse stays registered, for presentation and for zero impacts, until pruning. Owner-specific
 * cleanup (pursuit routes, unreleased windups) runs from the definition's `onDeathStarted`.
 */
export function startNpcDeath(npc: NpcActor): void {
  const death = npc.death;
  if (death?.status !== 'pending') return;
  death.status = 'started';
  // Movement stops through `canNpcActThisTurn`. This tick's step, if it already happened, is left for
  // the renderer to finish rather than cut short.
  if (npc.combat.retaliation) {
    npc.combat.retaliation.pending = [];
    npc.combat.retaliation.lastIncomingAttackTick = null;
  }
  refreshQueuedDeathAnimationTick(npc);
}

/** Records an engine-applied step; a pending-death NPC's final permitted step counts too. */
export function recordNpcStep(npc: NpcActor, tick: TickNumber): void {
  npc.lastStepTick = tick;
  refreshQueuedDeathAnimationTick(npc);
}

/** A scripted death animates as it is processed: the movement floor is for the hit queue's and timers' deaths. */
function refreshQueuedDeathAnimationTick(npc: NpcActor): void {
  const death = npc.death;
  if (death === undefined || npcDeathPolicy(npc) !== 'queued') return;
  npc.deathAnimationTick =
    death.causeStage === 'scripted' ? death.processTick : queuedDeathAnimationTick(death.processTick, npc.lastStepTick);
}

/**
 * Encounter-scripted death (a phase cleanup, the boss-HP tool): records and processes it at once.
 * Callers that hold an engine context also run the definition's `onDeathStarted`.
 */
export function markNpcDead(npc: NpcActor, deathTick: TickNumber): void {
  if (npc.death === undefined) recordNpcLethalTransition(npc, deathTick, 'scripted');
  npc.despawnTick ??= deathTick;
  startNpcDeath(npc);
}

/**
 * Scripted revival: a new life. The death record goes, and the life generation advances so hits
 * queued against the previous life never land on this one.
 */
export function reviveNpc(npc: NpcActor): void {
  // Only the despawn tick the death itself set; a scheduled one (a void flare's fuse) is not death state.
  if (npc.death !== undefined && npc.despawnTick === npc.death.killTick) npc.despawnTick = undefined;
  npc.alive = true;
  delete npc.death;
  delete npc.deathAnimationTick;
  npc.lifeGeneration = lifeGenerationOf(npc) + 1;
}

/** Corpse retention: from the later of the kill and the death animation (queued deaths). */
export function pruneGraceStartTick(npc: NpcActor): TickNumber | undefined {
  const start = npc.despawnTick;
  if (start === undefined || npc.death === undefined || npcDeathPolicy(npc) !== 'queued') return start;
  return Math.max(start, npc.deathAnimationTick ?? start);
}
