import type { NpcActor } from '../../core/actors/NpcActor';
import { isNpcActionReady, scheduleNpcAction } from '../../core/combat/npcActionClock';
import {
  type AttackPlan,
  canNpcAttack,
  projectileDistance,
  resolveAttackRequest,
} from '../../core/combat/npcAttackRequest';
import { emitEncounterVisual, type NpcProjectileCue } from '../../core/events/encounterVisual';
import { standardNpcCombatMove } from '../../core/npcCombatMovement';
import { canNpcActThisTurn } from '../../core/npcDeath';
import { createNpcDefinition, type DefinedNpcActor } from '../../core/npcs';
import { getMonsterFormulaStats, getMonsterHp } from '../../data/monsterData';
import type { Coordinate } from '../../types/simulation';
import { actorVisualTarget, npcProjectileSource } from '../projectileCue';
import { COLOSSEUM_SPOTANIMS, type ColosseumRelentlessRank } from './constants';
import { withRelentlessDefence, withRelentlessPlan } from './relentless';

/**
 * Fortis Colosseum serpent shaman, a wave 1-6 opener and a wave 4-6/10-11 reinforcement. Stats are the
 * Wiki infobox (/w/Serpent_shaman, oldid=15200480) as synced into `monsters.json`. Capture facts and
 * their status labels: `docs/encounters/fortis-colosseum-facts-spec.md` sections 6.2 and 6.3, with
 * A/B/C the wave recordings named in `__tests__/fixtures/serpentShamanCapture.ts`.
 */

/** RuneLite gameval `COLOSSEUM_STANDARD_MAGER`. */
export const SERPENT_SHAMAN_NPC_ID = 12811;

/** RuneLite gameval `NPC_SERPENT_MAGER_*` and `NPC_HUMAN_STAFFREADY_SPAWN`, as the captures play them. */
export const SERPENT_SHAMAN_SEQS = { spawn: 10861, cast: 10859, death: 10860 } as const;

export const SERPENT_SHAMAN_SPOTANIMS = {
  casting: COLOSSEUM_SPOTANIMS.shamanCasting,
  travel: COLOSSEUM_SPOTANIMS.shamanTravel,
  impact: COLOSSEUM_SPOTANIMS.shamanImpact,
} as const;
/** VERIFIED (241/241 casts): the casting graphic on the shaman, height 92, on the cast tick. */
export const SERPENT_SHAMAN_CASTING_HEIGHT = 92;
/** VERIFIED: the impact on the player, height 124, delayed to the projectile's end; accurate casts only. */
export const SERPENT_SHAMAN_IMPACT_HEIGHT = 124;

/** Wiki infobox and cache param 14: 5. VERIFIED: 196/210 gaps; the longer ones waited on the gate. */
export const SERPENT_SHAMAN_ATTACK_SPEED_TICKS = 5;
/** Wiki "range of 10 tiles". VERIFIED: casts at d 9-10 16/16, none at d >= 11 with line of sight. */
export const SERPENT_SHAMAN_ATTACK_RANGE = 10;
/** VERIFIED: never before add+3, and the 9 shamans able to cast then did (A:1336, B:1865, C:1454). */
export const SERPENT_SHAMAN_FIRST_CAST_TICKS = 3;
/** Wiki infobox: 28 magic (Strategies says 27); the captured unprayed maximum is 28 (C:1871). */
export const SERPENT_SHAMAN_MAX_HIT = 28;
/** VERIFIED: its `del` is the death sequence's tick + 3 (29/29). */
export const SERPENT_SHAMAN_REMOVAL_DELAY_TICKS = 3;

/**
 * VERIFIED (241/241): every Water Surge carries these fields, flying from the shaman's post-move tile
 * at the player.
 */
const PROJECTILE_FIELDS = {
  spotAnimId: SERPENT_SHAMAN_SPOTANIMS.travel,
  startDelayCycles: 67,
  slope: 14,
  startOffset: 32,
  startHeight: 172,
  endHeight: 146,
} as const satisfies Omit<NpcProjectileCue, 'sourcePosition' | 'target' | 'endDelayCycles'>;

/** CAPTURE-FIT (241/241, d 1..10): the projectile's `endtime` in client cycles. */
export function serpentShamanProjectileEndCycles(distance: number): number {
  return Math.max(80, 67 + 4 * distance);
}

/**
 * VERIFIED (every cast): the splat lands cast+3 through d 8 and cast+4 at d 9-10. This is not the
 * flight rule `floor(end / 30)`, which gives +3 for ends 103 and 107 (open question A8).
 */
export function serpentShamanHitDelayTicks(distance: number): number {
  return distance <= 8 ? 3 : 4;
}

const CAST_PLAN = {
  formulaStyle: 'magic',
  damageType: 'magic',
  attackKind: 'magic_water',
  // Replaced per cast by `serpentShamanHitDelayTicks`.
  impactDelayTicks: 3,
  maxHit: SERPENT_SHAMAN_MAX_HIT,
  // VERIFIED: a released Water Surge lands after the shaman dies, including a cast on its own killing
  // tick (A:1967 -> 1970, C:3226 -> 3229) and casts in flight at its death (A:1171, C:1474).
  sourceDeathPolicy: 'persist',
  // The default 'launch': protection is decided at the cast. VERIFIED: 186/186 prayed-at-cast casts did
  // 0, including ones unprayed on landing (B:2109 -> 2112), and unprayed-at-cast casts hit through a
  // prayer raised in flight (C:1867 -> 1871 = 28).
} as const satisfies AttackPlan & { readonly maxHit: number };

interface SerpentShamanState {
  readonly relentless: ColosseumRelentlessRank;
}
export type SerpentShamanActor = DefinedNpcActor<SerpentShamanState>;

function spawnTickOf(actor: NpcActor): number {
  return actor.spawnTick ?? 0;
}

export const serpentShamanDefinition = createNpcDefinition<SerpentShamanState, undefined>({
  id: 'colosseum-serpent-shaman',
  // The existing hit-queue rule: its death sequence starts on the killing tick (7) or the next (20).
  // Two that start at K+3 (A:1286, B:2473) are unexplained (open question A9).
  deathPolicy: 'queued',
  /**
   * CAPTURE-FIT (1588/1594 scored decisions): the standard greedy step toward the player's
   * start-of-tick tile while it lacks cast reach, held by pillars and NPCs rather than routed round
   * them (A:1148-1155). VERIFIED (8/8): on add+1 it steps once even with reach already; that walk-in
   * is the standard step without the cast-range stop (melee contact stands in for "no stop", MODEL:
   * no capture has the player adjacent on add+1).
   */
  move: ({ actor, context }) => {
    const { tick } = context;
    if (tick <= spawnTickOf(actor)) return [];
    if (tick === spawnTickOf(actor) + 1) {
      return standardNpcCombatMove({ ...actor, combat: { ...actor.combat, attackRange: 1 } }, context);
    }
    return standardNpcCombatMove(actor, context);
  },
  /**
   * After its own movement and before the player's, so `actor.position` is its post-move tile and the
   * player's is the start-of-tick tile the gate reads. CAPTURE-FIT (241/241 casts, 1484/1485 failing
   * ready ticks without one): cast when ready at range 1-10 with line of sight traced player -> shaman
   * (`hasNpcAttackReach`), so it can move and cast on one tick (A:3719). A shaman that began the tick
   * under the player steps off without casting (B:2102, B:2254).
   */
  tick: ({ actor, context }) => {
    const none = { environmentalDamages: [] };
    const { tick } = context;
    const player = context.world.getPlayer();
    if (!canNpcActThisTurn(actor, tick) || !isNpcActionReady(actor.combat, tick) || !player?.alive) return none;
    if (!canNpcAttack(actor, player, CAST_PLAN)) return none;
    const distance = projectileDistance(actor, player);
    const plan = { ...CAST_PLAN, impactDelayTicks: serpentShamanHitDelayTicks(distance) };
    // Relentless as for the warband (UNVERIFIED for the shaman).
    const { relentless } = actor.state;
    const attack = resolveAttackRequest({
      attacker: actor,
      target: relentless === 0 ? player : withRelentlessDefence(player, relentless),
      plan: relentless === 0 ? plan : withRelentlessPlan(plan, relentless),
      random: context.random,
    });
    if (attack === null) throw new TypeError(`Missing formula stats for ${actor.id}`);
    scheduleNpcAction(actor.combat, tick, SERPENT_SHAMAN_ATTACK_SPEED_TICKS);
    const endDelayCycles = serpentShamanProjectileEndCycles(distance);
    emitEncounterVisual(context.tickEvents, {
      animations: [{ actorId: actor.id, clipId: 'attack', delayCycles: 0 }],
      graphics: [
        {
          spotAnimId: SERPENT_SHAMAN_SPOTANIMS.casting,
          target: { kind: 'attached', actorId: actor.id },
          delayCycles: 0,
          height: SERPENT_SHAMAN_CASTING_HEIGHT,
        },
        // VERIFIED: an inaccurate cast shows no impact and no splash graphic, only its 0 splat (56/56).
        ...(attack.accuracySucceeded
          ? [
              {
                spotAnimId: SERPENT_SHAMAN_SPOTANIMS.impact,
                target: { kind: 'attached' as const, actorId: player.id },
                delayCycles: endDelayCycles,
                height: SERPENT_SHAMAN_IMPACT_HEIGHT,
              },
            ]
          : []),
      ],
      projectiles: [
        {
          ...PROJECTILE_FIELDS,
          endDelayCycles,
          sourcePosition: npcProjectileSource(actor),
          target: actorVisualTarget(player),
        },
      ],
    });
    return { environmentalDamages: [], npcAttacks: [attack] };
  },
});

export function createSerpentShaman(input: {
  readonly id: string;
  readonly position: Readonly<Coordinate>;
  readonly spawnTick: number;
  /** The run's Relentless tier; omitted means the modifier is off. */
  readonly relentless?: ColosseumRelentlessRank;
}): SerpentShamanActor {
  const hp = getMonsterHp(SERPENT_SHAMAN_NPC_ID);
  const formulaStats = getMonsterFormulaStats(SERPENT_SHAMAN_NPC_ID);
  if (hp === undefined || formulaStats === undefined) {
    throw new TypeError(`Missing Colosseum monster data for ${SERPENT_SHAMAN_NPC_ID}`);
  }
  const actor: NpcActor = {
    id: input.id,
    kind: 'npc',
    npcTypeId: SERPENT_SHAMAN_NPC_ID,
    archetypeId: 'colosseum_serpent_shaman',
    role: 'minion',
    size: 1,
    alive: true,
    position: [...input.position],
    previousPosition: [...input.position],
    facing: 0,
    spawnTick: input.spawnTick,
    vitals: { hp, maxHp: hp },
    history: new Map(),
    formulaStats: structuredClone(formulaStats),
    combat: {
      attackSpeed: SERPENT_SHAMAN_ATTACK_SPEED_TICKS,
      attackRange: SERPENT_SHAMAN_ATTACK_RANGE,
      attackStyle: 'magic',
      nextActionTick: input.spawnTick + SERPENT_SHAMAN_FIRST_CAST_TICKS,
      targetId: 'player',
      lastAttackTick: null,
      // Idle (813) and walk (1205) come from the cache NpcType.
      animations: {
        idle: null,
        walk: null,
        run: null,
        attack: SERPENT_SHAMAN_SEQS.cast,
        death: SERPENT_SHAMAN_SEQS.death,
      },
    },
  };
  return serpentShamanDefinition.createActor(actor, {
    relentless: input.relentless ?? 0,
  });
}
