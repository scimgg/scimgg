import type { NpcActor } from '../../core/actors/NpcActor';
import type { PlayerActor } from '../../core/actors/PlayerActor';
import { npcHitDelayFromEndTime } from '../../core/combat/hitDelay';
import { type AttackPlan, resolveAttackRequest } from '../../core/combat/npcAttackRequest';
import type { EncounterTickResult, NpcAttackRequest } from '../../core/encounters/types';
import { emitEncounterVisual, type NpcProjectileCue } from '../../core/events/encounterVisual';
import { canNpcActThisTurn } from '../../core/npcDeath';
import { createNpcDefinition, type DefinedNpcActor, type NpcDefinitionContext } from '../../core/npcs';
import type { WorldState } from '../../core/WorldState';
import { getMonsterFormulaStats, getMonsterHp } from '../../data/monsterData';
import type { Coordinate } from '../../types/simulation';
import { actorVisualTarget, npcProjectileSource } from '../projectileCue';
import { COLOSSUS_ATTACK_RANGE, hasColossusReach, moveColossus } from './colossusReach';
import { COLOSSEUM_SPOTANIMS, type ColosseumRelentlessRank } from './constants';
import { withRelentlessDefence, withRelentlessPlan } from './relentless';
import type { ColosseumHeldOrb } from './visualEvents';

/**
 * Fortis Colosseum Manticore (waves 4–11). Captures: A =
 * colosseum-waves-1-12-damage-trials-solarflare3-volatility3-bees1-totemic-doom1-death-packet-data.txt,
 * B = colosseum-waves-bees-death(no-sol)-packet-data-1.txt, C = colosseum-no-sol-packet-data.txt;
 * 27 instances, 191 throws, 572 orbs. Wiki: /w/Manticore (oldid 15200487). Ids are RuneLite gameval
 * names (1.13.7-SNAPSHOT) seen in the same captures.
 *
 * One cycle: it spots the player, charges (three orbs appear over it), throws the orbs on three
 * consecutive ticks once it has reach, and recharges. A charged Manticore without reach holds its
 * orbs indefinitely (A:2660 -> A:2863, 203 ticks behind the NW pillar).
 */
export const MANTICORE_NPC_ID = 12818; // COLOSSEUM_MANTICORE
export const MANTICORE_SIZE = 3;
/** Wiki "attack range of 15 tiles"; throws are seen up to box distance 10 and spotting at 15 (B:2630 instance). */
export const MANTICORE_ATTACK_RANGE = COLOSSUS_ATTACK_RANGE;

/** VERIFIED (26/26 first charges): spotting is ignored on spawn..spawn+2, so the earliest spot is spawn+3. */
export const MANTICORE_FIRST_SPOT_TICKS = 3;
/**
 * CAPTURE-FIT (26/26 first charges): the charge sequence starts 4 ticks after the first tick with reach
 * (A:1571 -> 1575, A:2656 -> 2660, C:1798 spawn -> C:1805), whether or not reach lasts (A:3811 -> 3815:
 * one tick of reach, none after, still charged).
 */
export const MANTICORE_SPOT_TO_CHARGE_TICKS = 4;
/** CAPTURE-FIT (0 mismatches over 1,204 ready ticks): the throw is the first tick >= charge+6 with reach. */
export const MANTICORE_CHARGE_TO_THROW_TICKS = 6;
/** VERIFIED (181/181, with or without reach): the next charge is the throw tick + 4 (A:1178 -> 1182). */
export const MANTICORE_THROW_TO_CHARGE_TICKS = 4;
/**
 * Wiki /w/Manticore: "When a manticore attacks, any other manticore that is ready to attack ... will have its
 * attack delayed by 5 ticks". VERIFIED for a ready one (10/10 blocked ticks; A:3428 -> 3433, C:3636 -> 3641),
 * after which the pair alternates exactly 5 apart. The Wiki's overlap for one NOT yet ready is uncaptured
 * (no such case in A/B/C) and follows the Wiki.
 */
export const MANTICORE_PAIR_DELAY_TICKS = 5;
/** VERIFIED (26/26): the corpse is removed 4 ticks after the death sequence (A:1218 -> 1222, A:4177 -> 4181). */
export const MANTICORE_DEATH_TO_REMOVAL_TICKS = 4;

/** RuneLite gameval `NPC_MANTICORE_01_*`; spawn_02 plays on the add tick of all 27 instances. */
export const MANTICORE_SEQS = {
  idle: 10863,
  walk: 10864,
  death: 10866,
  charge: 10868, // TRIPLE_CHARGE
  throw: 10869, // TRIPLE_THROW
  spawn: 10871, // SPAWN_02
} as const;

export type ManticoreOrbStyle = 'ranged' | 'magic' | 'melee';
/** The instance's first orb; the second is the other of the two and the third is always melee. */
export type ManticoreFirstStyle = Exclude<ManticoreOrbStyle, 'melee'>;

/** The same id is the held orb over its head and the thrown projectile (e.g. A:1137-1139 held, A:1178-1180 thrown). */
export const MANTICORE_ORB_SPOTANIMS = {
  ranged: COLOSSEUM_SPOTANIMS.manticoreRangedOrb,
  magic: COLOSSEUM_SPOTANIMS.manticoreMagicOrb,
  melee: COLOSSEUM_SPOTANIMS.manticoreMeleeOrb,
} as const satisfies Record<ManticoreOrbStyle, number>;

/**
 * VERIFIED (every held orb and every launch, A/B/C): by position in the throw, the held orb's height (slots
 * 1-3) and the projectile record's start height.
 */
export const MANTICORE_ORB_HEIGHTS = [300, 400, 500] as const;
const ORB_START_OFFSETS = [50, 0, 0] as const;
const ORB_FLIGHT = { startDelayCycles: 0, endDelayCycles: 30, slope: 127, endHeight: 50 } as const;

/**
 * Wiki infobox (oldid 15200487): 31 melee / 36 ranged / 31 magic. Unprotected samples fit: magic 13
 * (A:1703), ranged 9 (C:2018, Relentless I), melee 33 (B:3179, Relentless III, which allows 37).
 * The melee orb rolls stab: cache NpcType 12818 param 26 is 0, as on the stab-only warband berserker
 * (jaguar slash 1, minotaur crush 2) — DERIVED, the Wiki names no melee type.
 */
const ORB_PLANS: Readonly<Record<ManticoreOrbStyle, AttackPlan & { readonly maxHit: number }>> = {
  ranged: {
    formulaStyle: 'ranged',
    damageType: 'range',
    attackKind: 'range_arrow',
    // Wiki: "land with a projectile travel time of 0"; VERIFIED splat at launch+1 for every orb.
    impactDelayTicks: npcHitDelayFromEndTime(ORB_FLIGHT.endDelayCycles),
    maxHit: 36,
    // VERIFIED: no orb lands on or after its Manticore's kill tick, not even as a blocked 0 (10/10 kills
    // mid-throw, e.g. A:1723, A:4177/4178, C:1864); every earlier orb splats.
    sourceDeathPolicy: 'cancel-before-impact',
  },
  magic: {
    formulaStyle: 'magic',
    damageType: 'magic',
    attackKind: 'magic_fire',
    impactDelayTicks: npcHitDelayFromEndTime(ORB_FLIGHT.endDelayCycles),
    maxHit: 31,
    sourceDeathPolicy: 'cancel-before-impact',
  },
  melee: {
    formulaStyle: 'melee_stab',
    damageType: 'melee',
    attackKind: 'melee_stab',
    impactDelayTicks: npcHitDelayFromEndTime(ORB_FLIGHT.endDelayCycles),
    maxHit: 31,
    sourceDeathPolicy: 'cancel-before-impact',
  },
};

/** VERIFIED: the third orb is melee in 572/572 and the first two never change order within an instance (27/27). */
export function manticoreOrbSequence(first: ManticoreFirstStyle): readonly ManticoreOrbStyle[] {
  return [first, first === 'ranged' ? 'magic' : 'ranged', 'melee'];
}

/**
 * Where the instance is in its cycle. `launched` counts the throw's orbs already released, so a modifier
 * that changes the sequence (Mantimayhem, deferred) changes `orbs`, not this machine.
 */
export type ManticoreCycle =
  | { readonly phase: 'unspotted' }
  | { readonly phase: 'spotted'; readonly spotTick: number }
  | { readonly phase: 'charged'; readonly chargeTick: number }
  | { readonly phase: 'throwing'; readonly throwTick: number; readonly launched: number }
  | { readonly phase: 'recharging'; readonly throwTick: number };

interface ManticoreState {
  readonly orbs: readonly ManticoreOrbStyle[];
  readonly relentless: ColosseumRelentlessRank;
  cycle: ManticoreCycle;
  /** Read by the other Manticores for the pair delay; outlives the throw itself. */
  lastThrowTick: number | null;
}
export type ManticoreActor = DefinedNpcActor<ManticoreState>;

function spawnTickOf(actor: NpcActor): number {
  return actor.spawnTick ?? 0;
}

/**
 * The orbs held over its head after this tick's turn, bottom slot first. VERIFIED: they appear one a tick from
 * charge+1 (A:2661-2663), the server re-sends each every tick while held (A:2664-2670), and each slot clears on
 * its orb's launch tick. State-derived so a replay seek redraws them; none once dying.
 */
export function manticoreHeldOrbs(actor: ManticoreActor, tick: number): ColosseumHeldOrb[] {
  if (!actor.alive) return [];
  const { cycle, orbs } = actor.state;
  const from = cycle.phase === 'throwing' ? cycle.launched : 0;
  const to =
    cycle.phase === 'charged'
      ? Math.min(orbs.length, tick - cycle.chargeTick)
      : cycle.phase === 'throwing'
        ? orbs.length
        : 0;
  return orbs.slice(from, Math.max(from, to)).map((style, offset) => ({
    actorId: actor.id,
    spotAnimId: MANTICORE_ORB_SPOTANIMS[style],
    height: MANTICORE_ORB_HEIGHTS[from + offset]!,
  }));
}

/**
 * The first tick a charged Manticore may throw, given reach: charge+6, pushed to `MANTICORE_PAIR_DELAY_TICKS`
 * after any other Manticore's throw made while this one was already ready. Throws up to `tick` count,
 * including one made earlier this tick, so when both are ready on one tick the earlier in processing order
 * throws (A:3428 index 63702 before 63703; C:3636 index 35047 before 35048) — the engine's processing order is
 * spawn order. Both the throw gate and the attack timer read this.
 */
function earliestThrowTick(
  actor: ManticoreActor,
  chargeTick: number,
  world: Readonly<WorldState>,
  tick: number,
): number {
  const readyTick = chargeTick + MANTICORE_CHARGE_TO_THROW_TICKS;
  let earliest = readyTick;
  for (const other of world.getNpcs()) {
    if (other === actor || !manticoreDefinition.isActor(other)) continue;
    const thrown = other.state.lastThrowTick;
    if (thrown !== null && thrown >= readyTick && thrown <= tick)
      earliest = Math.max(earliest, thrown + MANTICORE_PAIR_DELAY_TICKS);
  }
  return earliest;
}

interface OrbLaunch {
  readonly attack: NpcAttackRequest;
  readonly projectile: NpcProjectileCue;
}

/**
 * Releases the throw's orb at `index`. Prayer is checked at this launch (the default timing): 489/489 orbs
 * with the matching prayer on at launch did no damage, 469 of them with it already off on landing
 * (A:1591-1593 ranged/magic/melee, each switched just in time).
 */
function launchOrb(
  actor: ManticoreActor,
  player: PlayerActor,
  index: number,
  context: NpcDefinitionContext,
): OrbLaunch {
  const style = actor.state.orbs[index]!;
  const { relentless } = actor.state;
  const attack = resolveAttackRequest({
    attacker: actor,
    target: relentless === 0 ? player : withRelentlessDefence(player, relentless),
    plan: relentless === 0 ? ORB_PLANS[style] : withRelentlessPlan(ORB_PLANS[style], relentless),
    random: context.random,
  });
  if (attack === null) throw new TypeError(`Missing formula stats for ${actor.id}`);
  // The first orb flies from the tile the Manticore threw from, after its step (9/9 throws made on a step).
  // Later orbs leave from where it started the tick (A:2864: it stepped south and orb 2 left the old center).
  const from = index === 0 ? actor.position : actor.previousPosition;
  return {
    attack,
    projectile: {
      ...ORB_FLIGHT,
      spotAnimId: MANTICORE_ORB_SPOTANIMS[style],
      startOffset: ORB_START_OFFSETS[index]!,
      startHeight: MANTICORE_ORB_HEIGHTS[index]!,
      sourcePosition: npcProjectileSource({ size: actor.size, position: from }),
      target: actorVisualTarget(player),
    },
  };
}

/**
 * Releases the started throw's next orb once it is due, one per tick. A started throw finishes without reach
 * (UNVERIFIED beyond A:2864, where it had none from its start tile and its second orb still flew).
 */
function releaseNextOrb(
  actor: ManticoreActor,
  player: PlayerActor,
  context: NpcDefinitionContext,
): EncounterTickResult {
  const { state } = actor;
  const { cycle } = state;
  if (cycle.phase !== 'throwing' || context.tick < cycle.throwTick + cycle.launched)
    return { environmentalDamages: [] };
  const { attack, projectile } = launchOrb(actor, player, cycle.launched, context);
  const launched = cycle.launched + 1;
  state.cycle =
    launched < state.orbs.length
      ? { phase: 'throwing', throwTick: cycle.throwTick, launched }
      : { phase: 'recharging', throwTick: cycle.throwTick };
  emitEncounterVisual(context.tickEvents, { animations: [], graphics: [], projectiles: [projectile] });
  return { environmentalDamages: [], npcAttacks: [attack] };
}

export const manticoreDefinition = createNpcDefinition<ManticoreState, undefined>({
  id: 'colosseum-manticore',
  /**
   * CAPTURE-FIT: an orb already thrown still launches on the killing tick, but nothing new starts. A:4177 launched
   * its second orb on its kill (zero-headbar) tick and never its third; A:1218, C:3047 and C:3716 were ready
   * with reach on theirs and did not throw. The death sequence lands on the kill tick in 23 of 26 deaths and a
   * tick later in 3 (the queued rule's processing tick; promotion and the last-step floor are engine-owned).
   */
  deathPolicy: 'queued',
  // VERIFIED (27/27 Manticores, as for the colossi): one approach step on the first turn after the add even
  // with reach (A:1128, C:1799), then the standard step until it has reach.
  move: ({ actor, context }) => moveColossus(actor, context),
  tick: ({ actor, context }) => {
    const none = { environmentalDamages: [] };
    const { tick, world } = context;
    const player = world.getPlayer();
    if (!canNpcActThisTurn(actor, tick) || !player?.alive) return none;
    const { state } = actor;
    const { cycle } = state;
    if (cycle.phase === 'throwing' || !actor.alive) return releaseNextOrb(actor, player, context);

    const clips: string[] = [];
    let launch: OrbLaunch | null = null;
    const charge = () => {
      state.cycle = { phase: 'charged', chargeTick: tick };
      clips.push('charge');
    };
    switch (cycle.phase) {
      // The colossi's reach gates every spot and throw too (191/191 throws, 0 mismatches over 1,204 ready ticks).
      case 'unspotted':
        if (tick >= spawnTickOf(actor) + MANTICORE_FIRST_SPOT_TICKS && hasColossusReach(actor, player)) {
          state.cycle = { phase: 'spotted', spotTick: tick };
        }
        break;
      case 'spotted':
        if (tick >= cycle.spotTick + MANTICORE_SPOT_TO_CHARGE_TICKS) charge();
        break;
      case 'charged': {
        if (tick >= earliestThrowTick(actor, cycle.chargeTick, world, tick) && hasColossusReach(actor, player)) {
          launch = launchOrb(actor, player, 0, context);
          state.cycle = { phase: 'throwing', throwTick: tick, launched: 1 };
          state.lastThrowTick = tick;
          clips.push('throw');
        }
        break;
      }
      case 'recharging':
        if (tick >= cycle.throwTick + MANTICORE_THROW_TO_CHARGE_TICKS) charge();
        break;
    }

    emitEncounterVisual(context.tickEvents, {
      animations: clips.map((clipId) => ({ actorId: actor.id, clipId, delayCycles: 0 })),
      graphics: [],
      projectiles: launch ? [launch.projectile] : [],
    });
    return launch ? { environmentalDamages: [], npcAttacks: [launch.attack] } : none;
  },
  attackTimer: ({ actor, context }) => {
    if (!canNpcActThisTurn(actor, context.tick)) return null;
    const { cycle } = actor.state;
    const period = MANTICORE_THROW_TO_CHARGE_TICKS + MANTICORE_CHARGE_TO_THROW_TICKS;
    switch (cycle.phase) {
      case 'unspotted':
        return null;
      case 'spotted':
        return {
          nextAttackTick: cycle.spotTick + MANTICORE_SPOT_TO_CHARGE_TICKS + MANTICORE_CHARGE_TO_THROW_TICKS,
          attackSpeed: period,
        };
      case 'charged':
        return {
          nextAttackTick: Math.max(
            context.tick,
            earliestThrowTick(actor, cycle.chargeTick, context.world, context.tick),
          ),
          attackSpeed: period,
        };
      case 'throwing':
      case 'recharging':
        return { nextAttackTick: cycle.throwTick + period, attackSpeed: period };
    }
  },
});

/**
 * Its kill turn when the hit queue promoted its death and so took the ordinary turn (`Encounter.releaseNpcKillTurn`,
 * routed by the wave owner with its own stream): the started throw's orb due on this tick still launches, as the
 * pending death's own turn would release it (A:4177), and is cancelled before it lands. Nothing new starts, and
 * no later orb follows (A:4178 had no third orb).
 */
export function releaseManticoreKillTurn(
  actor: ManticoreActor,
  context: NpcDefinitionContext,
): readonly NpcAttackRequest[] {
  const player = context.world.getPlayer();
  if (!player?.alive) return [];
  return releaseNextOrb(actor, player, context).npcAttacks ?? [];
}

export function createManticore(input: {
  readonly id: string;
  readonly position: Readonly<Coordinate>;
  readonly spawnTick: number;
  /** The run's Relentless tier; omitted means the modifier is off. */
  readonly relentless?: ColosseumRelentlessRank;
  /** Drawn by the wave owner; captures are consistent with an even split (10 magic, 12 ranged first). */
  readonly firstStyle: ManticoreFirstStyle;
}): ManticoreActor {
  const hp = getMonsterHp(MANTICORE_NPC_ID);
  const formulaStats = getMonsterFormulaStats(MANTICORE_NPC_ID);
  if (hp === undefined || formulaStats === undefined) {
    throw new TypeError(`Missing Colosseum monster data for ${MANTICORE_NPC_ID}`);
  }
  const actor: NpcActor = {
    id: input.id,
    kind: 'npc',
    npcTypeId: MANTICORE_NPC_ID,
    archetypeId: 'colosseum_manticore',
    role: 'minion',
    size: MANTICORE_SIZE,
    alive: true,
    position: [...input.position],
    previousPosition: [...input.position],
    facing: 0,
    spawnTick: input.spawnTick,
    vitals: { hp, maxHp: hp },
    history: new Map(),
    formulaStats: structuredClone(formulaStats),
    combat: {
      attackSpeed: MANTICORE_THROW_TO_CHARGE_TICKS + MANTICORE_CHARGE_TO_THROW_TICKS,
      attackRange: MANTICORE_ATTACK_RANGE,
      // The style of its first orb; each orb's request carries its own.
      attackStyle: ORB_PLANS[input.firstStyle].damageType,
      nextActionTick: 0,
      targetId: 'player',
      lastAttackTick: null,
      animations: {
        idle: MANTICORE_SEQS.idle,
        walk: MANTICORE_SEQS.walk,
        run: null,
        attack: MANTICORE_SEQS.throw,
        death: MANTICORE_SEQS.death,
      },
    },
  };
  return manticoreDefinition.createActor(actor, {
    orbs: manticoreOrbSequence(input.firstStyle),
    relentless: input.relentless ?? 0,
    cycle: { phase: 'unspotted' },
    lastThrowTick: null,
  });
}
