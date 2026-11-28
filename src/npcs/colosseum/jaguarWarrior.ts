import type { NpcActor } from '../../core/actors/NpcActor';
import { isNpcActionReady, scheduleNpcAction } from '../../core/combat/npcActionClock';
import { type AttackPlan, canNpcAttack, resolveAttackRequest } from '../../core/combat/npcAttackRequest';
import type { NpcAttackRequest } from '../../core/encounters/types';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { standardNpcCombatMove } from '../../core/npcCombatMovement';
import { canNpcActThisTurn } from '../../core/npcDeath';
import { createNpcDefinition, type DefinedNpcActor } from '../../core/npcs';
import { getMonsterFormulaStats, getMonsterHp } from '../../data/monsterData';
import type { Coordinate } from '../../types/simulation';
import type { ColosseumRelentlessRank } from './constants';
import { withRelentlessDefence, withRelentlessPlan } from './relentless';

/**
 * Fortis Colosseum jaguar warrior, a wave 1-6 reinforcement. Stats are the Wiki infobox
 * (/w/Jaguar_warrior, oldid=15319602) as synced into `monsters.json`. Capture facts and their status
 * labels: `docs/encounters/fortis-colosseum-facts-spec.md` sections 6.2 and 6.4, with A/B/C the wave
 * recordings named in `__tests__/fixtures/jaguarWarriorCapture.ts`.
 */

/** RuneLite gameval `COLOSSEUM_JAGUAR_WARRIOR`. */
export const JAGUAR_WARRIOR_NPC_ID = 12810;
export const JAGUAR_WARRIOR_SIZE = 2;

/** RuneLite gameval `NPC_JAGUAR_RANGER_CLAWS_ATTACK`, `NPC_JAGUAR_HUMAN_DEATH`, `NPC_HUMAN_READY_SPAWN`. */
export const JAGUAR_WARRIOR_SEQS = { spawn: 10862, attack: 10847, death: 10849 } as const;

/** Wiki infobox and cache param 14: 5. VERIFIED: 57/58 gaps; the other waited out of reach. */
export const JAGUAR_WARRIOR_ATTACK_SPEED_TICKS = 5;
/**
 * The shared wave-NPC spawn lockout (facts spec 6.2, VERIFIED for the species that could attack
 * sooner). No jaguar reached the player before add+5 (B:1997), where it swung at once.
 */
export const JAGUAR_WARRIOR_FIRST_ATTACK_TICKS = 3;
/** Wiki: "Always attacks three times", "each hit having its own independent accuracy and strength roll". */
export const JAGUAR_WARRIOR_HITS_PER_ATTACK = 3;
/** Wiki infobox: 47 slash per hit. The one unprayed captured attack rolled 0/0/0 (C:1732). */
export const JAGUAR_WARRIOR_MAX_HIT = 47;
/** VERIFIED: its `del` is the death sequence's tick + 3 (14/14). */
export const JAGUAR_WARRIOR_REMOVAL_DELAY_TICKS = 3;

const CLAW_PLAN = {
  formulaStyle: 'melee_slash',
  damageType: 'melee',
  attackKind: 'melee_slash',
  // VERIFIED (65/65 attacks not on its killing tick): all three splats land on the attack tick.
  impactDelayTicks: 0,
  maxHit: JAGUAR_WARRIOR_MAX_HIT,
  // VERIFIED (A:1443, A:1908, C:1626): a swing on its own killing tick plays and lands nothing.
  sourceDeathPolicy: 'cancel-before-impact',
} as const satisfies AttackPlan & { readonly maxHit: number };

interface JaguarWarriorState {
  readonly relentless: ColosseumRelentlessRank;
}
export type JaguarWarriorActor = DefinedNpcActor<JaguarWarriorState>;

function spawnTickOf(actor: NpcActor): number {
  return actor.spawnTick ?? 0;
}

export const jaguarWarriorDefinition = createNpcDefinition<JaguarWarriorState, undefined>({
  id: 'colosseum-jaguar-warrior',
  // The existing hit-queue rule: its death sequence starts on the killing tick (6) or the next (8).
  deathPolicy: 'queued',
  /**
   * CAPTURE-FIT (564/595 greedy decisions, one tile per tick from add+1): the standard greedy step,
   * held by pillars and NPCs. The misses are the player under its 2x2 footprint and some diagonal
   * choices (open question A10); no leap or routing (150/150 one-tile walks).
   */
  move: ({ actor, context }) => (context.tick > spawnTickOf(actor) ? standardNpcCombatMove(actor, context) : []),
  /**
   * After its own movement and before the player's. CAPTURE-FIT (70/70): it attacks when ready and
   * cardinally adjacent from its post-move footprint to the player's start-of-tick tile, so it can
   * step and attack on one tick (C:1732); never diagonally (A:1407, C:1763) or with the player under
   * it (C:1610). One claw animation carries three hits with their own rolls.
   */
  tick: ({ actor, context }) => {
    const none = { environmentalDamages: [] };
    const { tick } = context;
    const player = context.world.getPlayer();
    if (!canNpcActThisTurn(actor, tick) || !isNpcActionReady(actor.combat, tick) || !player?.alive) return none;
    if (!canNpcAttack(actor, player, CLAW_PLAN)) return none;
    // Relentless as for the warband (UNVERIFIED for the jaguar).
    const { relentless } = actor.state;
    const target = relentless === 0 ? player : withRelentlessDefence(player, relentless);
    const plan = relentless === 0 ? CLAW_PLAN : withRelentlessPlan(CLAW_PLAN, relentless);
    const attacks: NpcAttackRequest[] = [];
    for (let hit = 0; hit < JAGUAR_WARRIOR_HITS_PER_ATTACK; hit++) {
      const attack = resolveAttackRequest({ attacker: actor, target, plan, random: context.random });
      if (attack === null) throw new TypeError(`Missing formula stats for ${actor.id}`);
      // The later hits are components of the one accepted attack, not attacks of their own.
      attacks.push(hit === 0 ? attack : { ...attack, isContinuation: true });
    }
    scheduleNpcAction(actor.combat, tick, JAGUAR_WARRIOR_ATTACK_SPEED_TICKS);
    emitEncounterVisual(context.tickEvents, {
      animations: [{ actorId: actor.id, clipId: 'attack', delayCycles: 0 }],
      projectiles: [],
      graphics: [],
    });
    return { environmentalDamages: [], npcAttacks: attacks };
  },
});

export function createJaguarWarrior(input: {
  readonly id: string;
  readonly position: Readonly<Coordinate>;
  readonly spawnTick: number;
  /** The run's Relentless tier; omitted means the modifier is off. */
  readonly relentless?: ColosseumRelentlessRank;
}): JaguarWarriorActor {
  const hp = getMonsterHp(JAGUAR_WARRIOR_NPC_ID);
  const formulaStats = getMonsterFormulaStats(JAGUAR_WARRIOR_NPC_ID);
  if (hp === undefined || formulaStats === undefined) {
    throw new TypeError(`Missing Colosseum monster data for ${JAGUAR_WARRIOR_NPC_ID}`);
  }
  const actor: NpcActor = {
    id: input.id,
    kind: 'npc',
    npcTypeId: JAGUAR_WARRIOR_NPC_ID,
    archetypeId: 'colosseum_jaguar_warrior',
    role: 'minion',
    size: JAGUAR_WARRIOR_SIZE,
    alive: true,
    position: [...input.position],
    previousPosition: [...input.position],
    facing: 0,
    spawnTick: input.spawnTick,
    vitals: { hp, maxHp: hp },
    history: new Map(),
    formulaStats: structuredClone(formulaStats),
    combat: {
      attackSpeed: JAGUAR_WARRIOR_ATTACK_SPEED_TICKS,
      attackRange: 1,
      attackStyle: 'melee',
      nextActionTick: input.spawnTick + JAGUAR_WARRIOR_FIRST_ATTACK_TICKS,
      targetId: 'player',
      lastAttackTick: null,
      // Idle (808) and walk (819) come from the cache NpcType.
      animations: {
        idle: null,
        walk: null,
        run: null,
        attack: JAGUAR_WARRIOR_SEQS.attack,
        death: JAGUAR_WARRIOR_SEQS.death,
      },
    },
  };
  return jaguarWarriorDefinition.createActor(actor, {
    relentless: input.relentless ?? 0,
  });
}
