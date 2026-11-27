import type { Coordinate, NpcCrawlMovement, NpcRole, TickNumber } from '../../types/simulation';
import type { NpcDeathPolicy, NpcDeathRecord } from '../npcDeath';
import type { ActorBase } from './ActorBase';
import type { ActorId, NpcCombatState, NpcFormulaStats } from './types';

export interface NpcDebuffs {
  /** Mutate through `setNpcDefenceDrain` to respect encounter-owned floors. */
  defenceDrain?: number;
  magicDrain?: number;
  /**
   * Drained by Shadow spells (/w/Shadow_spells). Like the two above it, this persists for the
   * rest of the encounter: OSRS restores a drained NPC stat over time, which no drain in this
   * sim models, and giving Attack a restoration clock the dragon warhammer's Defence drain does
   * not have would make the two disagree about the same fight.
   */
  attackDrain?: number;
  strengthDrain?: number;
  /**
   * Half-open tick window `[boundFromTick, boundUntilTick)` over which the NPC cannot move.
   *
   * A window, not a countdown, because a bind can be SCHEDULED ahead of the tick it takes hold on.
   */
  boundFromTick?: number;
  boundUntilTick?: number;
}

export function isNpcBound(npc: NpcActor, tick: number): boolean {
  const { boundFromTick, boundUntilTick } = npc.debuffs ?? {};
  if (boundUntilTick === undefined) return false;
  return tick >= (boundFromTick ?? 0) && tick < boundUntilTick;
}

/**
 * /w/Ice_spells: a target cannot be re-frozen until five ticks after its freeze ENDS, and a live
 * freeze cannot be refreshed by another cast. Both rules read off the end of the bind window, so
 * one comparison covers them — which also, correctly, stops an Ice spell topping up a Zamorak
 * godsword bind. OSRS runs binds and freezes off the same immunity.
 */
export const FREEZE_IMMUNITY_TICKS = 5;

export function isNpcFreezeImmune(npc: NpcActor, tick: number): boolean {
  const until = npc.debuffs?.boundUntilTick;
  return until !== undefined && tick < until + FREEZE_IMMUNITY_TICKS;
}

export type NpcBurnOrigin = 'eclipse' | 'special-attack';

export interface NpcBurnStack {
  readonly origin: NpcBurnOrigin;
  readonly sourceId: ActorId;
  readonly pulsesRemaining: number;
}

/**
 * Ordinary (non-venom) poison on an NPC. Mutate it through `npcPoison.ts` so the severity and
 * its pulse clock stay paired.
 */
export interface NpcPoison {
  readonly sourceId: ActorId;
  /** Counts down one per pulse; damage is derived from it, never stored. */
  readonly severity: number;
  readonly nextPulseTick: number;
}

export interface NpcDefinitionIdentity {
  readonly id: string;
}

export interface NpcActor<State extends object = object> extends ActorBase {
  kind: 'npc';
  crawlMovement?: NpcCrawlMovement;
  npcTypeId: number;
  archetypeId: string;
  history: Map<TickNumber, Coordinate>;
  combat: NpcCombatState;
  /**
   * This registration's place in the world's NPC processing order, assigned once by
   * `WorldState.registerNpc` (registration order, a MODEL of the server's index allocator).
   * Absent until registered.
   */
  readonly processingOrder?: number;
  readonly definition?: NpcDefinitionIdentity;
  readonly state?: State;
  role?: NpcRole;
  formulaStats?: NpcFormulaStats;
  /**
   * Not drawn while set: the NPC stays in the world (hits already in flight still land on it) but has
   * no model on screen, as Zulrah between diving and resurfacing. Pair it with
   * {@link targetableFromTick} so nothing can target what cannot be seen.
   */
  hidden?: boolean;
  /** Minimum Defence level after drains; absent means no encounter-specific cap. */
  defenceDrainFloor?: number;
  /**
   * A hit landing on this NPC above `above` is replaced by a uniform draw in `[min, max]` (Zulrah:
   * over 50 becomes 45-50). Applied at impact, before the remaining-HP clamp. Absent means no cap.
   */
  incomingHitCap?: { readonly above: number; readonly min: number; readonly max: number };
  spawnTick?: TickNumber;
  despawnTick?: TickNumber;
  /** Encounter-owned respawn lifecycle retains this corpse until revival or explicit despawn. */
  retainAfterDeath?: boolean;
  /**
   * First tick the player may target this NPC; it is also hidden from the cursor and shows no
   * health bar before then (unless {@link healthBarWhenUntargetable}). Set from the definition's
   * `spawnUntargetableTicks`, or by {@link submergeNpc} while an NPC is temporarily out of reach. Unlike
   * `attackBlockedUntilTick`, this models an NPC that is not yet interactive at all.
   */
  targetableFromTick?: TickNumber;
  /**
   * Never targetable by the player at all (damageable scenery such as Inferno's Rocky supports):
   * as {@link targetableFromTick} before its tick, for the whole life of the actor. Its own flag, not
   * a far-future tick: ticks reach replay clocks, which must stay finite.
   */
  untargetable?: true;
  /**
   * The despawn timer bar completes this many ticks before `despawnTick` and holds full for the
   * remainder. Absent means it completes on `despawnTick` itself.
   */
  despawnTimerLeadTicks?: number;
  /** Keep the health bar up for the NPC's whole targetable life instead of only after a hit. */
  alwaysShowHealthBar?: boolean;
  /**
   * Show the health bar on hits even while the player cannot target the NPC, for damageable
   * scenery such as Inferno's Rocky supports, which only other NPCs attack. Targetability itself
   * (cursor, menus, attacks) is unchanged.
   */
  healthBarWhenUntargetable?: boolean;
  /**
   * `'practice'` when a practice aid (an encounter command) spawned this NPC; absent for the
   * fight's own spawns. Mechanic toggles gate only the fight's own: see {@link isPracticeSpawn}.
   */
  spawnOrigin?: NpcSpawnOrigin;
  attackBlockedUntilTick?: TickNumber;
  debuffs?: NpcDebuffs;
  burnStacks?: NpcBurnStack[];
  /**
   * Mutate burns through `burnStacks.ts` or `clearBurnStacks` so stacks and their clock stay paired.
   */
  burnNextPulseTick?: number;
  poison?: NpcPoison;
  /** Next natural-regen tick; undefined means no regen. Set through `npcRegeneration.ts`. */
  hitpointRegenNextTick?: number;
  /** Step tiles taken this tick (for render interpolation of a moving NPC). */
  movementPath?: Coordinate[];
  /** Whether the NPC changed tiles this tick. */
  isMoving?: boolean;
  /** Whether the NPC moved >1 tile this tick (running cadence). */
  isRunning?: boolean;
  /**
   * This NPC ignores other ACTORS' occupancy when it steps, so it can walk through them.
   * Terrain and static loc collision still apply. Defaults to false.
   *
   * OSRS keeps blocking on TWO independent axes and only the CHECK side is modeled here:
   * what an entity writes to the collision map is separate from what it tests when routing.
   * So a pass-through NPC still BLOCKS others; it merely is not blocked BY them, which is
   * why two of them end up sharing a tile — exactly what the Yt-HurKot do in the wave-69
   * capture. An NPC that needs to stop blocking others is the OTHER axis; add that
   * separately rather than overloading this flag.
   */
  passThruNpcs?: boolean;
  /**
   * Keeps moving while its target player stands underneath with an active red-X interaction,
   * where the engine otherwise holds an NPC in place (`isNpcMovementSuppressed`). Binds still hold it.
   * Defaults to false.
   */
  movesWithAttackerUnder?: boolean;
  /**
   * If set, this NPC's orientation is permanently pinned to this OSRS angle,
   * ignoring actions, combat targets, and movement (e.g. Zuk's shield).
   */
  lockedFacing?: number;
  /**
   * OSRS angle snapshotted by the NPC's latest facing-relevant action. Unlike
   * `combat.targetId`, this does not continuously turn toward a moving actor.
   */
  actionFacing?: number;
  /**
   * On a tick it moves, this NPC faces its steps rather than its combat target: the client is sent a
   * facing reset while it walks and the target again once it stops. Defaults to false, where an
   * in-combat NPC keeps facing its target while it moves.
   */
  facesStepsWhileMoving?: boolean;
  /**
   * Tick a `queued` NPC's death animation starts, kept by `npcDeath.ts` from its death record and last
   * step (`queuedDeathAnimationTick`). Cleared with each new death record and on revival, so a value
   * always belongs to the current death; unset for `immediate` deaths, which animate at once.
   */
  deathAnimationTick?: TickNumber;
  /**
   * Why a dead NPC died, when its definition tells causes apart (a void flare that detonated
   * rather than being killed). Unset for an ordinary kill.
   */
  deathCause?: string;
  /** When death processing runs; stamped from the definition. Absent means `immediate`. See `npcDeath.ts`. */
  deathPolicy?: NpcDeathPolicy;
  /** This life's death, from the first transition to 0 HP until revival. Mutate through `npcDeath.ts`. */
  death?: NpcDeathRecord;
  /** Advanced by every scripted revival, so hits queued against an earlier life never land. Absent is 0. */
  lifeGeneration?: number;
  /** Last tick the engine applied a step for this NPC; feeds the death animation floor. */
  lastStepTick?: TickNumber;
}

export type NpcSpawnOrigin = 'practice';

/**
 * Whether a practice aid spawned this NPC (actor or snapshot). A mechanic toggle suppresses the
 * fight's own instances of a mechanic, never the ones the player asked for.
 */
export function isPracticeSpawn(npc: { readonly spawnOrigin?: NpcSpawnOrigin }): boolean {
  return npc.spawnOrigin === 'practice';
}

/** Shared by the engine (actors) and the UI (snapshots), so both gate on one rule. */
export function isNpcTargetable(
  npc: { readonly targetableFromTick?: TickNumber; readonly untargetable?: true },
  tick: number,
): boolean {
  if (npc.untargetable === true) return false;
  return npc.targetableFromTick === undefined || tick >= npc.targetableFromTick;
}

/** Whether the NPC's health bar may show at `tick`: while targetable, or always when it opts in. */
export function canShowNpcHealthBar(
  npc: {
    readonly targetableFromTick?: TickNumber;
    readonly untargetable?: true;
    readonly healthBarWhenUntargetable?: boolean;
  },
  tick: number,
): boolean {
  return npc.healthBarWhenUntargetable === true || isNpcTargetable(npc, tick);
}

export function canInitiateAttackOnNpc(npc: NpcActor, tick: TickNumber): boolean {
  if (!isNpcTargetable(npc, tick)) return false;
  return npc.attackBlockedUntilTick === undefined || tick >= npc.attackBlockedUntilTick;
}

/**
 * Out of reach below ground or water (a burrowed Jal-ImKot) until `untilTick`: untargetable — no new
 * attacks, cursor or health bar, and skipped by area and ricochet targeting. Occupancy is separate and
 * unchanged: the Jal-ImKot's old footprint keeps blocking other NPCs until it resurfaces. Hits already
 * queued against it still resolve as the hit queue decides. {@link surfaceNpc} restores targeting.
 */
export function submergeNpc(npc: NpcActor, untilTick: TickNumber): void {
  npc.targetableFromTick = untilTick;
}

export function surfaceNpc(npc: NpcActor): void {
  delete npc.targetableFromTick;
}

/** Store the shared drain once so combat and projections see the same effective Defence. */
export function setNpcDefenceDrain(npc: NpcActor, drain: number): void {
  npc.debuffs ??= {};
  const floor = npc.defenceDrainFloor;
  npc.debuffs.defenceDrain =
    floor === undefined ? drain : Math.min(drain, Math.max(0, (npc.formulaStats?.levels.defence ?? 1) - floor));
}

export function clearBurnStacks(npc: NpcActor): void {
  npc.burnStacks = [];
  npc.burnNextPulseTick = undefined;
}

export function clearNpcPoison(npc: NpcActor): void {
  npc.poison = undefined;
}
