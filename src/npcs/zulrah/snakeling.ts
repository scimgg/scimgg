import { isNpcTargetable, type NpcActor } from '../../core/actors/NpcActor';
import type { PlayerActor } from '../../core/actors/PlayerActor';
import { isNpcActionReady, scheduleNpcAction } from '../../core/combat/npcActionClock';
import { type AttackPlan, canNpcAttack, resolveAttackRequest } from '../../core/combat/npcAttackRequest';
import { contextAttackDecisions, contextDecisions } from '../../core/decisionRandom';
import { canNpcActThisTurn, canReceiveNewAttack } from '../../core/npcDeath';
import { isArenaFootprintWalkable } from '../../core/npcMovementCollision';
import { type NpcPursuitProfile, pursuePlayer } from '../../core/npcPursuit';
import { createNpcDefinition } from '../../core/npcs';
import { VENOM_THRESHOLD } from '../../core/poison';
import { getMonsterFormulaStats, getMonsterHp } from '../../data/monsterData';
import type { Coordinate, TickNumber } from '../../types/simulation';
import { emitInfernoVisual } from '../inferno/visualEvents';
import { actorVisualTarget, npcProjectileSource } from '../projectileCue';
import {
  SNAKELING,
  SNAKELING_MAGIC_NPC_ID,
  SNAKELING_MAGIC_SPOTANIM_ID,
  SNAKELING_MELEE_NPC_ID,
  SNAKELING_SEQS,
  SNAKELING_VENOM_CHANCE,
} from './constants';

export type SnakelingStyle = 'melee' | 'magic';

type SnakelingState = {
  readonly style: SnakelingStyle;
  /** The snakeling dies off on this tick (`SNAKELING.lifetimeTicks` after it lands). */
  readonly expireTick: TickNumber;
};

export type SnakelingConfig = {
  readonly attacksEnabled: () => boolean;
  /** Whether attacks may envenom (`SNAKELING_VENOM_CHANCE`). */
  readonly venomEnabled: () => boolean;
};

const PLANS: Readonly<Record<SnakelingStyle, AttackPlan>> = {
  melee: {
    formulaStyle: 'melee_stab',
    damageType: 'melee',
    attackKind: 'melee_stab',
    impactDelayTicks: 0,
    maxHit: SNAKELING.meleeMaxHit,
    sourceDeathPolicy: 'cancel-before-impact',
  },
  magic: {
    formulaStyle: 'magic',
    damageType: 'magic',
    attackKind: 'magic_water',
    // Simulator policy: a short bolt, landing the tick after it is cast.
    impactDelayTicks: 1,
    maxHit: SNAKELING.magicMaxHit,
    sourceDeathPolicy: 'persist',
  },
};

const PURSUIT: NpcPursuitProfile = {
  size: 1,
  maxSpeed: 1,
  underFootprint: 'random-cardinal',
  unreachable: 'nearest-reachable',
  canOccupy: isArenaFootprintWalkable,
};

export const snakelingDefinition = createNpcDefinition<SnakelingState, SnakelingConfig>({
  id: 'zulrah-snakeling',
  move: ({ actor, context }) => {
    const player = context.world.getPlayer();
    if (!canNpcActThisTurn(actor, context.tick) || !actor.alive || !player?.alive) return [];
    // Holds still while it can already attack, as the magic ones do from range.
    if (canNpcAttack(actor, player, PLANS[actor.state.style])) return [];
    return pursuePlayer(actor, player.position, context.random, PURSUIT);
  },
  tick: ({ actor, config, context }) => {
    const none = { environmentalDamages: [] };
    const player = context.world.getPlayer();
    if (!canNpcActThisTurn(actor, context.tick) || !actor.alive || !player || !canReceiveNewAttack(player)) return none;
    if (!isNpcTargetable(actor, context.tick) || !isNpcActionReady(actor.combat, context.tick)) return none;
    const plan = PLANS[actor.state.style];
    if (!canNpcAttack(actor, player, plan)) return none;
    scheduleNpcAction(actor.combat, context.tick, SNAKELING.attackSpeedTicks);
    const attack = resolveAttackRequest({
      attacker: actor,
      target: player,
      random: context.random,
      labelled: contextAttackDecisions(context),
      plan,
    });
    if (!attack) throw new TypeError(`Missing formula stats for ${actor.id}`);
    const venom =
      config.venomEnabled() &&
      contextDecisions(context).chance(
        { site: 'zulrah.snakeling.venom', tick: context.tick, actorId: actor.id },
        SNAKELING_VENOM_CHANCE,
      );
    actor.combat.lastAttackTick = context.tick;
    // With attacks off the rolls are still drawn, as for Zulrah's own turns, so the encounter's stream
    // stays aligned with an all-on run; only the attack, its venom and visual are dropped.
    if (!config.attacksEnabled()) return none;
    emitInfernoVisual(context.tickEvents, {
      animations: [{ actorId: actor.id, clipId: 'attack', delayCycles: 0 }],
      projectiles: actor.state.style === 'magic' ? [magicBolt(actor, player)] : [],
      graphics: [],
    });
    return { environmentalDamages: [], npcAttacks: [venom ? { ...attack, applyPoison: VENOM_THRESHOLD } : attack] };
  },
});

function magicBolt(actor: NpcActor, player: PlayerActor) {
  return {
    spotAnimId: SNAKELING_MAGIC_SPOTANIM_ID,
    sourcePosition: npcProjectileSource(actor),
    target: actorVisualTarget(player),
    startDelayCycles: 10,
    endDelayCycles: 30,
    slope: 16,
    startOffset: 32,
    startHeight: 60,
    endHeight: 80,
  };
}

export function createSnakeling(input: {
  readonly id: string;
  readonly style: SnakelingStyle;
  readonly position: Coordinate;
  readonly spawnTick: TickNumber;
}) {
  const npcTypeId = input.style === 'melee' ? SNAKELING_MELEE_NPC_ID : SNAKELING_MAGIC_NPC_ID;
  const hp = getMonsterHp(npcTypeId);
  const formulaStats = getMonsterFormulaStats(npcTypeId);
  if (hp === undefined || formulaStats === undefined) throw new TypeError(`Missing snakeling data for ${npcTypeId}`);
  const actor: NpcActor = {
    id: input.id,
    kind: 'npc',
    role: 'minion',
    alive: true,
    position: [input.position[0], input.position[1]],
    previousPosition: [input.position[0], input.position[1]],
    facing: 0,
    size: 1,
    vitals: { hp, maxHp: hp },
    npcTypeId,
    archetypeId: `zulrah_snakeling_${input.style}`,
    spawnTick: input.spawnTick,
    history: new Map<TickNumber, Coordinate>(),
    combat: {
      attackSpeed: SNAKELING.attackSpeedTicks,
      attackRange: input.style === 'magic' ? SNAKELING.magicRange : 1,
      attackStyle: input.style,
      nextActionTick: input.spawnTick + SNAKELING.firstAttackDelayTicks,
      targetId: 'player',
      lastAttackTick: null,
      animations: {
        idle: null,
        walk: null,
        run: null,
        attack: SNAKELING_SEQS.attack,
        death: SNAKELING_SEQS.death,
      },
    },
    formulaStats,
  };
  return snakelingDefinition.createActor(actor, {
    style: input.style,
    expireTick: input.spawnTick + SNAKELING.lifetimeTicks,
  });
}

export function snakelingExpireTick(actor: NpcActor): TickNumber | null {
  return snakelingDefinition.getState(actor)?.expireTick ?? null;
}
