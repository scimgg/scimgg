import type { NpcActor } from '../../core/actors/NpcActor';
import { hasLineOfSight } from '../../core/combat/distance';
import { isNpcActionReady, scheduleNpcAction } from '../../core/combat/npcActionClock';
import { type AttackPlan, canNpcAttack, resolveAttackRequest } from '../../core/combat/npcAttackRequest';
import { applyNpcHealing } from '../../core/combat/npcHealing';
import type { NpcMovementRequest } from '../../core/encounters/types';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { isNpcMovementSuppressed, standardNpcCombatMove } from '../../core/npcCombatMovement';
import { canNpcActThisTurn, canReceiveHealing, isNpcLiving } from '../../core/npcDeath';
import { isArenaFootprintWalkable } from '../../core/npcMovementCollision';
import { createNpcStepOccupancyPredicate } from '../../core/npcOccupancy';
import { type NpcPursuitProfile, pursuePlayer } from '../../core/npcPursuit';
import { createNpcDefinition, type DefinedNpcActor, type NpcDefinitionContext } from '../../core/npcs';
import { getMonsterFormulaStats, getMonsterHp } from '../../data/monsterData';
import type { Coordinate } from '../../types/simulation';
import { COLOSSEUM_SPOTANIMS, type ColosseumRelentlessRank } from './constants';
import { withRelentlessDefence, withRelentlessPlan } from './relentless';

/**
 * Fortis Colosseum Minotaur, a wave 7-11 reinforcement. Stats are the Wiki infobox
 * (/w/Minotaur_(Fortis_Colosseum), oldid=15412054) as synced into `monsters.json`. Capture citations
 * use A/B/C for the three wave recordings named in `__tests__/fixtures/minotaurCapture.ts`, which
 * replays every captured minotaur life (11) against this file.
 */

/** RuneLite gameval `COLOSSEUM_MINOTAUR`. */
export const MINOTAUR_NPC_ID = 12812;
/**
 * RuneLite gameval `COLOSSEUM_MINOTAUR_ROUTEFIND`, the wave minotaur while Red Flag is owned. WIKI-ONLY
 * (no capture has Red Flag): it routefinds around obstacles and cannot be safespotted
 * (/w/Fortis_Colosseum/Modifiers oldid=15163385; /w/Minotaur_(Fortis_Colosseum) oldid=15412054), and
 * other NPCs can move into its tiles (/w/Fortis_Colosseum/Strategies oldid=15414089). It shares 12812's
 * stats row; everything else here is 12812's behavior. UNKNOWN: its cache param 26 is 4 where
 * 12812's is 2 (perhaps the Monster Examine attack-type text); nothing here reads it.
 */
export const MINOTAUR_ROUTEFIND_NPC_ID = 12813;
const MINOTAUR_NPC_IDS: ReadonlySet<number> = new Set([MINOTAUR_NPC_ID, MINOTAUR_ROUTEFIND_NPC_ID]);
export const MINOTAUR_SIZE = 3;

/** RuneLite gameval `NPC_MINOTAUR_BOSS_*`; captures A/B/C play 10841/10843/10844/10845/10846. */
export const MINOTAUR_SEQS = {
  defend: 10841,
  attack: 10843,
  /** `ATTACK_MAGIC` by name, but its only capture (C:2478) is the ally heal; no magic attack exists. */
  heal: 10844,
  spawn: 10845,
  death: 10846,
} as const;
/** On the healed NPC on the heal tick; no projectile (C:2478). */
export const MINOTAUR_HEAL_SPOTANIM = { spotAnimId: COLOSSEUM_SPOTANIMS.minotaurHeal, height: 128 } as const;

/** Wiki infobox and cache param 14: 5. VERIFIED: 58/60 melee gaps; the other two waited out of reach. */
export const MINOTAUR_ATTACK_SPEED_TICKS = 5;
/**
 * CAPTURE-FIT: the first action is add+3. C:2478 heals at add+3 with its target already in reach at
 * add+1/+2, and C:3511 would heal at add+1 or +2 but is out of reach by +3, so it never heals.
 */
export const MINOTAUR_FIRST_ACTION_TICKS = 3;
/**
 * SINGLE-OBSERVATION policy: a heal costs 10 ticks before the next action. C:2478's minotaur is in
 * melee reach from C:2487 but first swings at C:2488 = heal+10.
 */
export const MINOTAUR_HEAL_COOLDOWN_TICKS = 10;
/** Wiki infobox: 74 crush. Captures have no unprayed minotaur hit (all 66 are 0 under Protect from Melee). */
export const MINOTAUR_MAX_HIT = 74;

/**
 * Heal scan, quoted from Mod Arcane on the Wiki NPC page (oldid=15412054): on its timer, if the player
 * is not in melee range, it scans 10 tiles from its center for an NPC that is not a minotaur, below 75%
 * HP, whose center is in line of sight of the minotaur's center and at most 7 tiles away, and heals it
 * (to full, Wiki). Both radii are Chebyshev from the center here (MODEL), so the 7 binds and the 10 adds
 * nothing. The Strategies page says 6; no capture separates 6/7/8, but 10 alone would heal at A:2714 and
 * A:3317, and dropping line of sight would heal at C:2710, C:2932 and A:2735, none of which happen.
 */
export const MINOTAUR_HEAL_REACH_TILES = 7;
export const MINOTAUR_HEAL_HP_FRACTION = 0.75;

/**
 * DERIVED (11/11 lives close at exactly 0 HP, 340/340 headbars match; `minotaurCapture.test.ts`):
 * +5 HP, capped at max and without a hitsplat, every 20 ticks from the spawn tick, not a global
 * modulus. The captures show it ahead of the hits of add+1+20k (B:3062, C:2748 and the two otherwise
 * overkilling final hits B:3082, A:2389 need that order), which is the same as after the hits of
 * add+20k: it runs at the end of its own turn then, and nothing else damages it between its turns.
 * The engine's generic regeneration stays off for this NPC; this is its only regeneration.
 */
export const MINOTAUR_REGEN_AMOUNT = 5;
export const MINOTAUR_REGEN_INTERVAL_TICKS = 20;

/** VERIFIED: its `del` is the death sequence's tick + 4 (11/11), one later than the shaman's and jaguar's. */
export const MINOTAUR_REMOVAL_DELAY_TICKS = 4;

const MELEE_PLAN = {
  formulaStyle: 'melee_crush',
  damageType: 'melee',
  attackKind: 'melee_crush',
  // VERIFIED: the splat lands the tick after the swing (66/66, e.g. C:2488 -> 2489).
  impactDelayTicks: 1,
  maxHit: MINOTAUR_MAX_HIT,
  // SINGLE-OBSERVATION: A:4485's swing lands at 4486, the tick its source is killed and starts dying.
  sourceDeathPolicy: 'persist',
} as const satisfies AttackPlan & { readonly maxHit: number };

interface MinotaurState {
  nextRegenTick: number;
  readonly relentless: ColosseumRelentlessRank;
}
export type MinotaurActor = DefinedNpcActor<MinotaurState>;

function spawnTickOf(actor: NpcActor): number {
  return actor.spawnTick ?? 0;
}

/** The center tile the server measures from: south-west + floor(size / 2), as `projectileDistance`. */
function centerOf(npc: Pick<NpcActor, 'position' | 'size'>): Coordinate {
  const offset = Math.floor(npc.size / 2);
  return [npc.position[0] + offset, npc.position[1] + offset];
}

/**
 * The scan's choice among the living NPCs, or null. Candidates are taken in NPC processing order and
 * the first eligible one wins (simulator tie policy; the scan's own order is unknown). The line of
 * sight is traced target center -> minotaur center, the engine's NPC convention; the reverse ray fits
 * every capture equally.
 */
export function selectMinotaurHealTarget(
  minotaur: Pick<NpcActor, 'id' | 'position' | 'size'>,
  npcs: readonly NpcActor[],
): NpcActor | null {
  const [mx, my] = centerOf(minotaur);
  const candidates = npcs
    .filter((npc) => npc.id !== minotaur.id && !MINOTAUR_NPC_IDS.has(npc.npcTypeId) && canReceiveHealing(npc))
    .sort((left, right) => (left.processingOrder ?? 0) - (right.processingOrder ?? 0));
  for (const npc of candidates) {
    if (npc.vitals.hp >= npc.vitals.maxHp * MINOTAUR_HEAL_HP_FRACTION) continue;
    const [tx, ty] = centerOf(npc);
    if (Math.max(Math.abs(tx - mx), Math.abs(ty - my)) > MINOTAUR_HEAL_REACH_TILES) continue;
    if (hasLineOfSight(tx, ty, mx, my)) return npc;
  }
  return null;
}

/** One +5 pulse when due; at full HP the pulse is spent without effect, like the generic clock. */
function advanceMinotaurRegen(actor: MinotaurActor, tick: number): void {
  if (!canReceiveHealing(actor) || tick < actor.state.nextRegenTick) return;
  actor.state.nextRegenTick += MINOTAUR_REGEN_INTERVAL_TICKS;
  actor.vitals = {
    ...actor.vitals,
    hp: Math.min(actor.vitals.maxHp, actor.vitals.hp + MINOTAUR_REGEN_AMOUNT),
  };
}

/**
 * Red Flag's routefinding: the production melee route search (`pursuePlayer`, as Sol's pursuit), one
 * tile per tick like 12812, toward cardinal reach of the player's start-of-tick tile. UNVERIFIED, beyond
 * the Wiki's "move around obstacles": the speed, that other NPCs still block its own steps (as they
 * block 12812's), a random cardinal step out from under the player, and walking to the nearest
 * reachable tile when no route reaches.
 */
function routeTowardPlayer(actor: MinotaurActor, context: NpcDefinitionContext): NpcMovementRequest[] {
  const player = context.world.getPlayer();
  if (!canNpcActThisTurn(actor, context.tick) || !player?.alive || isNpcMovementSuppressed(actor, player, context.tick))
    return [];
  const canEnterActors = createNpcStepOccupancyPredicate(context.world.occupancy);
  const profile: NpcPursuitProfile = {
    size: actor.size,
    maxSpeed: 1,
    canOccupy: isArenaFootprintWalkable,
    canStep: canEnterActors,
    underFootprint: 'random-cardinal',
    unreachable: 'nearest-reachable',
  };
  return pursuePlayer(actor, player.position, context.random, profile);
}

export const minotaurDefinition = createNpcDefinition<MinotaurState, undefined>({
  id: 'colosseum-minotaur',
  // The existing hit-queue rule: its death sequence starts on the killing tick (9/11) or the next (2/11).
  deathPolicy: 'queued',
  // Wiki: "minotaurs will immediately move upon spawning"; every capture's first step is add+1.
  move: ({ actor, context }) => {
    if (context.tick <= spawnTickOf(actor)) return [];
    return actor.npcTypeId === MINOTAUR_ROUTEFIND_NPC_ID
      ? routeTowardPlayer(actor, context)
      : standardNpcCombatMove(actor, context);
  },
  /**
   * After its own movement and before the player's, so `actor.position` is its post-move tile and the
   * player's is the start-of-tick tile the captures gate on. Other NPCs earlier in processing order
   * have already taken this tick's hits, which is why C:2478's javelin takes its 7 before the heal.
   */
  tick: ({ actor, context }) => {
    const none = { environmentalDamages: [] };
    const { tick } = context;
    if (!canNpcActThisTurn(actor, tick) || tick <= spawnTickOf(actor)) return none;
    advanceMinotaurRegen(actor, tick);
    const player = context.world.getPlayer();
    if (!isNpcActionReady(actor.combat, tick) || !player?.alive) return none;
    // VERIFIED (66/66): it swings when ready and cardinally adjacent after its move, never diagonally.
    if (canNpcAttack(actor, player, MELEE_PLAN)) {
      // Relentless as for the warband (UNVERIFIED here: no unprayed minotaur hit was captured).
      const { relentless } = actor.state;
      const attack = resolveAttackRequest({
        attacker: actor,
        target: relentless === 0 ? player : withRelentlessDefence(player, relentless),
        plan: relentless === 0 ? MELEE_PLAN : withRelentlessPlan(MELEE_PLAN, relentless),
        random: context.random,
      });
      if (attack === null) throw new TypeError(`Missing formula stats for ${actor.id}`);
      scheduleNpcAction(actor.combat, tick, MINOTAUR_ATTACK_SPEED_TICKS);
      emitEncounterVisual(context.tickEvents, {
        animations: [{ actorId: actor.id, clipId: 'attack', delayCycles: 0 }],
        projectiles: [],
        graphics: [],
      });
      return { environmentalDamages: [], npcAttacks: [attack] };
    }
    // A dying minotaur's kept turn does not heal (UNVERIFIED: never captured either way).
    if (!isNpcLiving(actor)) return none;
    const target = selectMinotaurHealTarget(actor, context.world.getNpcs());
    if (target === null) return none;
    applyNpcHealing(target, target.vitals.maxHp - target.vitals.hp, context.tickEvents);
    scheduleNpcAction(actor.combat, tick, MINOTAUR_HEAL_COOLDOWN_TICKS);
    emitEncounterVisual(context.tickEvents, {
      animations: [{ actorId: actor.id, clipId: 'heal', delayCycles: 0 }],
      projectiles: [],
      graphics: [{ ...MINOTAUR_HEAL_SPOTANIM, target: { kind: 'attached', actorId: target.id }, delayCycles: 0 }],
    });
    return none;
  },
  onDamageResolved: ({ actor, damage, context }) => {
    if (damage.effectiveDamage < 0 || damage.hpAfter <= 0 || damage.hpAfter > damage.hpBefore) return;
    emitEncounterVisual(context.tickEvents, {
      animations: [{ actorId: actor.id, clipId: 'defend', delayCycles: 0 }],
      projectiles: [],
      graphics: [],
    });
  },
});

export function createMinotaur(input: {
  readonly id: string;
  readonly position: Readonly<Coordinate>;
  readonly spawnTick: number;
  /** The run's Relentless tier; omitted means the modifier is off. */
  readonly relentless?: ColosseumRelentlessRank;
  /** Red Flag is owned: the routefinding variant 12813. Omitted means the ordinary 12812. */
  readonly routefinding?: boolean;
}): MinotaurActor {
  const npcTypeId = input.routefinding === true ? MINOTAUR_ROUTEFIND_NPC_ID : MINOTAUR_NPC_ID;
  const hp = getMonsterHp(npcTypeId);
  const formulaStats = getMonsterFormulaStats(npcTypeId);
  if (hp === undefined || formulaStats === undefined) {
    throw new TypeError(`Missing Colosseum monster data for ${npcTypeId}`);
  }
  const actor: NpcActor = {
    id: input.id,
    kind: 'npc',
    npcTypeId,
    archetypeId: 'colosseum_minotaur',
    role: 'minion',
    size: MINOTAUR_SIZE,
    alive: true,
    position: [...input.position],
    previousPosition: [...input.position],
    facing: 0,
    spawnTick: input.spawnTick,
    // WIKI (Strategies oldid=15414089): other NPCs can move into a Red Flag minotaur's tiles.
    ...(npcTypeId === MINOTAUR_ROUTEFIND_NPC_ID ? { blocksNpcMovement: false } : {}),
    vitals: { hp, maxHp: hp },
    history: new Map(),
    formulaStats: structuredClone(formulaStats),
    combat: {
      attackSpeed: MINOTAUR_ATTACK_SPEED_TICKS,
      attackRange: 1,
      attackStyle: 'melee',
      nextActionTick: input.spawnTick + MINOTAUR_FIRST_ACTION_TICKS,
      targetId: 'player',
      lastAttackTick: null,
      // Idle (10840) and walk (10842) come from the cache NpcType.
      animations: { idle: null, walk: null, run: null, attack: MINOTAUR_SEQS.attack, death: MINOTAUR_SEQS.death },
    },
  };
  return minotaurDefinition.createActor(actor, {
    nextRegenTick: input.spawnTick + MINOTAUR_REGEN_INTERVAL_TICKS,
    relentless: input.relentless ?? 0,
  });
}
