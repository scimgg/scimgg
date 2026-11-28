import type { NpcActor } from '../../core/actors/NpcActor';
import type { PlayerActor } from '../../core/actors/PlayerActor';
import type { DamageType } from '../../core/actors/types';
import { isNpcActionReady, scheduleNpcAction } from '../../core/combat/npcActionClock';
import { hasNpcAttackReach } from '../../core/combat/npcAttackRequest';
import type { NpcMovementRequest } from '../../core/encounters/types';
import { standardNpcCombatMove } from '../../core/npcCombatMovement';
import { isNpcLiving } from '../../core/npcDeath';
import type { NpcDefinitionContext } from '../../core/npcs';
import { getMonsterFormulaStats, getMonsterHp } from '../../data/monsterData';
import type { Coordinate } from '../../types/simulation';

/**
 * The turn rules the Javelin and Shockwave Colossi share: approach, reach, attack clock and actor shape.
 * Evidence: `docs/encounters/fortis-colosseum-facts-spec.md` §6.2, replayed through these functions by
 * `__tests__/colossusReachCapture.test.ts`.
 */

/** Wiki infoboxes and the cache NpcType: both colossi are 3×3. */
export const COLOSSUS_SIZE = 3;
/** VERIFIED: attacks at box distance 15 and none at 16+ with line of sight (both species). */
export const COLOSSUS_ATTACK_RANGE = 15;
/** VERIFIED: 5-tick cycle for both (javelin 379/412 gaps, shockwave all gaps but line-of-sight waits). */
export const COLOSSUS_ATTACK_PERIOD_TICKS = 5;
/**
 * CAPTURE-FIT: the first attack is no earlier than add+3. Javelin: 3 instances attacked at add+3 and
 * none on 65 earlier ticks that passed the gate; shockwave: no gate-passing tick at add+3/add+4 was
 * captured (earliest cast add+5), so its lockout is the javelin's (MODEL).
 */
export const COLOSSUS_FIRST_ATTACK_TICKS = 3;

/**
 * VERIFIED (42/42 instances, A/B/C): the first turn after the add takes one approach step even when the
 * gate already passes (A:838 (29,31)→(28,32)), the step the standard pursuit takes toward a target it
 * cannot yet reach. After that it is the standard combat step, stopping once it has reach. CAPTURE-FIT:
 * replayed from add+2 with the other wave NPCs' footprints blocking (but not the warband's, solar
 * flares', thralls', bees' or totems'), it matches 7,572 of 7,581 javelin and shockwave ticks; the
 * misses are the player under the footprint (a random escape step), the player's or its own death, and
 * two stalls (B:2742, C:3367). That replay needs every NPC's track, so it is not a checked-in fixture.
 */
export function moveColossus(actor: NpcActor, context: NpcDefinitionContext): NpcMovementRequest[] {
  const spawnTick = actor.spawnTick ?? 0;
  if (context.tick <= spawnTick) return [];
  if (context.tick === spawnTick + 1) {
    return standardNpcCombatMove({ ...actor, combat: { ...actor.combat, attackRange: 1 } }, context);
  }
  return standardNpcCombatMove(actor, context);
}

/**
 * CAPTURE-FIT (javelin 444/444 attacks, shockwave 63/63, no attack on any other ready tick): from the
 * colossus's post-move footprint, box distance 1..15 to the player's start-of-tick tile, with line of
 * sight traced from the player's tile to the nearest footprint tile; the arena pillars block. That is
 * production's target-to-attacker reach, so the caller runs it after movement and before the player's.
 */
export function hasColossusReach(actor: NpcActor, player: PlayerActor): boolean {
  return hasNpcAttackReach(actor, player, COLOSSUS_ATTACK_RANGE);
}

/**
 * Whether the colossus launches an attack this turn. CAPTURE-FIT: one at 0 HP never launches on its
 * killing tick, even ready with reach and with its death processed a tick later (A:2249, A:3346, B:3256).
 */
export function canColossusLaunch(actor: NpcActor, player: PlayerActor | null, tick: number): player is PlayerActor {
  return (
    player?.alive === true &&
    isNpcLiving(actor) &&
    isNpcActionReady(actor.combat, tick) &&
    hasColossusReach(actor, player)
  );
}

/** Starts the next 5-tick wait; the artillery cast counts as an attack (javelin gaps of 5 either side). */
export function scheduleColossusAttack(actor: NpcActor, tick: number): void {
  scheduleNpcAction(actor.combat, tick, COLOSSUS_ATTACK_PERIOD_TICKS);
}

export interface ColossusActorInput {
  readonly id: string;
  readonly position: Readonly<Coordinate>;
  readonly spawnTick: number;
}

export function createColossusActor(
  input: ColossusActorInput,
  identity: {
    readonly npcTypeId: number;
    readonly archetypeId: string;
    readonly attackStyle: DamageType;
    readonly seqs: { readonly idle: number; readonly walk: number; readonly attack: number; readonly death: number };
  },
): NpcActor {
  const hp = getMonsterHp(identity.npcTypeId);
  const formulaStats = getMonsterFormulaStats(identity.npcTypeId);
  if (hp === undefined || formulaStats === undefined) {
    throw new TypeError(`Missing Colosseum monster data for ${identity.npcTypeId}`);
  }
  return {
    id: input.id,
    kind: 'npc',
    npcTypeId: identity.npcTypeId,
    archetypeId: identity.archetypeId,
    role: 'minion',
    size: COLOSSUS_SIZE,
    alive: true,
    position: [...input.position],
    previousPosition: [...input.position],
    facing: 0,
    spawnTick: input.spawnTick,
    // Blocking and being blocked by other NPCs is what the movement replay needs (pillar queues behind
    // a shaman or another colossus, e.g. A:1810, A:2656); the warband, flares and thralls do not block.
    vitals: { hp, maxHp: hp },
    history: new Map(),
    formulaStats: structuredClone(formulaStats),
    combat: {
      attackSpeed: COLOSSUS_ATTACK_PERIOD_TICKS,
      attackRange: COLOSSUS_ATTACK_RANGE,
      attackStyle: identity.attackStyle,
      nextActionTick: input.spawnTick + COLOSSUS_FIRST_ATTACK_TICKS,
      targetId: 'player',
      lastAttackTick: null,
      animations: {
        idle: identity.seqs.idle,
        walk: identity.seqs.walk,
        run: null,
        attack: identity.seqs.attack,
        death: identity.seqs.death,
      },
    },
  };
}
