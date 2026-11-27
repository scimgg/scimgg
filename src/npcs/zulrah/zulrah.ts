import type { NpcActor } from '../../core/actors/NpcActor';
import type { PlayerActor } from '../../core/actors/PlayerActor';
import { calculateProjectileEndTime } from '../../core/combat/hitDelay';
import { isNpcActionReady, scheduleNpcAction } from '../../core/combat/npcActionClock';
import { type AttackPlan, projectileDistance, resolveAttackRequest } from '../../core/combat/npcAttackRequest';
import { contextAttackDecisions, contextDecisions } from '../../core/decisionRandom';
import type { EncounterTickResult, EnvironmentalDamage } from '../../core/encounters/types';
import { canNpcActThisTurn, canReceiveNewAttack } from '../../core/npcDeath';
import { createNpcDefinition, type NpcDefinitionContext } from '../../core/npcs';
import { VENOM_THRESHOLD } from '../../core/poison';
import { getMonsterFormulaStats } from '../../data/monsterData';
import type { Coordinate, TickNumber } from '../../types/simulation';
import { emitInfernoVisual } from '../inferno/visualEvents';
import { actorVisualTarget, type NpcProjectileCue, npcProjectileSource } from '../projectileCue';
import {
  PLAYER_STUNNED_SPOTANIM_ID,
  SNAKELING,
  ZULRAH_ATTACK_SPEED_TICKS,
  ZULRAH_CLOUD,
  ZULRAH_CLOUD_ORB_SPOTANIM_ID,
  ZULRAH_HIT_CAP,
  ZULRAH_MAGIC_SPOTANIM_ID,
  ZULRAH_MAX_HIT,
  ZULRAH_NPC_ID_BY_FORM,
  ZULRAH_PROJECTILE_TIMING,
  ZULRAH_RANGED_SPOTANIM_ID,
  ZULRAH_SIZE,
  ZULRAH_SNAKELING_ORB_SPOTANIM_ID,
  ZULRAH_SURFACE_FACING_TILE,
  ZULRAH_TAIL,
  ZULRAH_TAIL_SAFE_TILES,
  type ZulrahForm,
} from './constants';

/**
 * How a phase attacks.
 * - `ranged`: serpentine's ranged-only volley.
 * - `mixed`: tanzanite picks magic or ranged per attack.
 * - `jad`: serpentine alternating ranged and magic, opening on `jadOpening`.
 * - `tail`: magma's stare-then-slam on the player's tile (`ZULRAH_TAIL`).
 * - `idle`: no attacks, only specials (clouds, snakelings).
 */
export type ZulrahAttackMode = 'ranged' | 'mixed' | 'jad' | 'tail' | 'idle';
export type ZulrahStyle = 'range' | 'magic';

/** One of Zulrah's turns: a ranged/magic attack, a tail slam, a cloud barrage or a snakeling orb. */
export type ZulrahAction = 'attack' | 'tail' | 'cloud' | 'snakeling';

export type ZulrahActorState = {
  form: ZulrahForm;
  mode: ZulrahAttackMode;
  jadOpening: ZulrahStyle;
  /** The phase's turns still to take, front first. */
  actions: ZulrahAction[];
  /** Ranged/magic attacks and tails made, for the jad alternation. */
  attacksMade: number;
  /** Tick the last turn's effect lands (a hit, a tail, a cloud); the encounter waits for it before diving. */
  lastImpactTick: TickNumber | null;
  /** The tail in progress: the tile it locked when the stare began, and the tick it lands. */
  pendingTail: { readonly target: Coordinate; readonly landTick: TickNumber } | null;
};

export type ZulrahDefinitionConfig = {
  /**
   * Tanzanite's chance to pick magic. The wiki gives no number, only "will randomly attack with
   * both Magic and Ranged attacks, although it uses magic much more frequently"
   * (https://oldschool.runescape.wiki/w/Zulrah/Strategies). Simulator policy: 0.75.
   */
  readonly tanzaniteMagicChance: number;
  readonly attacksEnabled: () => boolean;
  /** Whether attacks may envenom (`ZULRAH_VENOM`). */
  readonly venomEnabled: () => boolean;
  /** Called when a tail lands on the player: stuns them (no moving or attacking) until the given tick. */
  readonly stunPlayer: (untilTick: TickNumber) => void;
  /**
   * Called on a cloud turn: the encounter places the barrage's clouds and returns the tiles its
   * orbs fly to (empty when clouds are switched off).
   */
  readonly launchCloudBarrage: (actor: NpcActor, context: NpcDefinitionContext) => readonly Coordinate[];
  /**
   * Called on a snakeling turn: the encounter picks where the orb lands and spawns the snakeling there
   * when it does. Returns that tile, or null (snakelings off, or nowhere to land).
   */
  readonly launchSnakelingOrb: (actor: NpcActor, context: NpcDefinitionContext) => Coordinate | null;
};

export type CreateZulrahActorInput = {
  readonly id: string;
  readonly form: ZulrahForm;
  readonly mode: ZulrahAttackMode;
  readonly actions: readonly ZulrahAction[];
  readonly jadOpening?: ZulrahStyle;
  readonly position: Coordinate;
  readonly hp: number;
  readonly maxHp: number;
  readonly spawnTick: TickNumber;
  /** Ticks after `spawnTick` before it can be targeted (the emerge). */
  readonly emergeTicks: number;
  /** Ticks after `spawnTick` before its first turn; `emergeTicks` when absent. */
  readonly firstTurnDelayTicks?: number;
};

const PLANS: Readonly<Record<ZulrahStyle, AttackPlan>> = {
  range: {
    formulaStyle: 'ranged',
    damageType: 'range',
    attackKind: 'range_arrow',
    impactDelayTicks: 0,
    projectile: ZULRAH_PROJECTILE_TIMING,
    maxHit: ZULRAH_MAX_HIT,
    // Main page: damage is decided when the attack is generated, so a released hit lands even if
    // Zulrah dies or dives meanwhile.
    sourceDeathPolicy: 'persist',
  },
  magic: {
    formulaStyle: 'magic',
    damageType: 'magic',
    attackKind: 'magic_water',
    impactDelayTicks: 0,
    projectile: ZULRAH_PROJECTILE_TIMING,
    maxHit: ZULRAH_MAX_HIT,
    sourceDeathPolicy: 'persist',
  },
};

const SPOTANIM_BY_STYLE: Readonly<Record<ZulrahStyle, number>> = {
  range: ZULRAH_RANGED_SPOTANIM_ID,
  magic: ZULRAH_MAGIC_SPOTANIM_ID,
};

const EMPTY: EncounterTickResult = { environmentalDamages: [] };

export const zulrahDefinition = createNpcDefinition<ZulrahActorState, ZulrahDefinitionConfig>({
  id: 'zulrah',
  move: false,
  tick: ({ actor, config, context }) => {
    const state = actor.state;
    const player = context.world.getPlayer();
    const damages = landTail(actor, state, config, context);
    if (state.pendingTail || state.actions.length === 0) return { environmentalDamages: damages };
    if (!canNpcActThisTurn(actor, context.tick) || !actor.alive) return { environmentalDamages: damages };
    // Its first turn after a form change (emerge + 3) comes before it can be targeted (emerge + 4).
    if (actor.hidden || !isNpcActionReady(actor.combat, context.tick)) return { environmentalDamages: damages };
    if (!player || !canReceiveNewAttack(player)) return { environmentalDamages: damages };

    const action = state.actions.shift();
    switch (action) {
      case 'attack': {
        const result = takeAttack(actor, state, config, context, player);
        return { ...result, environmentalDamages: damages };
      }
      case 'tail':
        startTail(actor, state, config, context, player);
        return { environmentalDamages: damages };
      case 'cloud':
        spitClouds(actor, state, config, context);
        return { environmentalDamages: damages };
      case 'snakeling':
        spitSnakelingOrb(actor, state, config, context);
        return { environmentalDamages: damages };
      case undefined:
        return { environmentalDamages: damages };
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  },
});

function takeAttack(
  actor: NpcActor,
  state: ZulrahActorState,
  config: ZulrahDefinitionConfig,
  context: NpcDefinitionContext,
  player: PlayerActor,
): EncounterTickResult {
  scheduleNpcAction(actor.combat, context.tick, ZULRAH_ATTACK_SPEED_TICKS);
  // An attack turn faces the player, dropping the bearing a surfacing or a spit left (private gameplay
  // capture zulrah-packet-data-1.txt, e.g. t258; also t301, where the turn made no attack).
  delete actor.actionFacing;
  if (!config.attacksEnabled()) {
    // Spends the turn without the attack, so the phase keeps its length.
    state.lastImpactTick = context.tick;
    return EMPTY;
  }
  // Reported from play: it faces south until the player hits it or it first attacks, then tracks the player.
  actor.combat.targetId = 'player';
  const style = selectStyle(actor, state, config, context);
  const attack = resolveAttackRequest({
    attacker: actor,
    target: player,
    random: context.random,
    labelled: contextAttackDecisions(context),
    plan: PLANS[style],
  });
  if (!attack) throw new TypeError(`Missing formula stats for ${actor.id}`);
  // Every ranged or magic attack that does not miss envenoms, prayer or not (`ZULRAH_VENOM`).
  const venom = config.venomEnabled() && attack.accuracySucceeded;
  state.attacksMade += 1;
  state.lastImpactTick = context.tick + attack.impactDelayTicks;
  actor.combat.attackStyle = style;
  actor.combat.lastAttackTick = context.tick;
  emitInfernoVisual(context.tickEvents, {
    animations: [{ actorId: actor.id, clipId: 'attack', delayCycles: 0 }],
    projectiles: [projectileCue(actor, player, style)],
    graphics: [],
  });
  return { environmentalDamages: [], npcAttacks: [venom ? { ...attack, applyPoison: VENOM_THRESHOLD } : attack] };
}

function selectStyle(
  actor: NpcActor,
  state: ZulrahActorState,
  config: ZulrahDefinitionConfig,
  context: NpcDefinitionContext,
): ZulrahStyle {
  switch (state.mode) {
    case 'ranged':
      return 'range';
    case 'jad': {
      const other: ZulrahStyle = state.jadOpening === 'range' ? 'magic' : 'range';
      return state.attacksMade % 2 === 0 ? state.jadOpening : other;
    }
    case 'mixed':
      return contextDecisions(context).chance(
        { site: 'zulrah.tanzanite.style', tick: context.tick, actorId: actor.id },
        config.tanzaniteMagicChance,
      )
        ? 'magic'
        : 'range';
    case 'tail':
    case 'idle':
      throw new TypeError(`A ${state.mode} Zulrah phase has no ranged or magic attack`);
    default: {
      const exhaustive: never = state.mode;
      return exhaustive;
    }
  }
}

/** A tail whose stare has run its course lands: damage and a stun if the player is still under it. */
function landTail(
  actor: NpcActor,
  state: ZulrahActorState,
  config: ZulrahDefinitionConfig,
  context: NpcDefinitionContext,
): EnvironmentalDamage[] {
  const pending = state.pendingTail;
  if (!pending || context.tick < pending.landTick) return [];
  state.pendingTail = null;
  // The stare is over: Zulrah tracks the player again.
  delete actor.actionFacing;
  scheduleNpcAction(actor.combat, context.tick, ZULRAH_TAIL.recoveryTicks);
  const player = context.world.getPlayer();
  if (
    !actor.alive ||
    !player ||
    !canReceiveNewAttack(player) ||
    !config.attacksEnabled() ||
    !isInTailArea(player.position, pending.target) ||
    isTailSafeTile(actor.position, player.position)
  )
    return [];
  config.stunPlayer(context.tick + ZULRAH_TAIL.stunTicks);
  context.tickEvents.emit({ type: 'player_graphic_applied', spotAnimId: PLAYER_STUNNED_SPOTANIM_ID });
  return [
    {
      baseDamage: ZULRAH_TAIL.damage,
      attackType: 'typeless',
      source: 'Zulrah tail',
      playerPosition: [...player.position],
    },
  ];
}

/** Locks the player's tile and starts the stare. A disabled attack still spends its stare. */
function startTail(
  actor: NpcActor,
  state: ZulrahActorState,
  config: ZulrahDefinitionConfig,
  context: NpcDefinitionContext,
  player: PlayerActor,
): void {
  const landTick = context.tick + ZULRAH_TAIL.stareTicks;
  state.pendingTail = { target: [player.position[0], player.position[1]], landTick };
  // Zulrah stares at the locked tile, not at the player: it holds this bearing until the slam.
  actor.actionFacing = facingToward(actor, state.pendingTail.target);
  state.attacksMade += 1;
  state.lastImpactTick = landTick;
  actor.combat.lastAttackTick = context.tick;
  // Holds the clock until the tail lands; the landing reschedules the next stare.
  scheduleNpcAction(actor.combat, context.tick, ZULRAH_TAIL.stareTicks);
  if (config.attacksEnabled()) {
    // Tracks the player once the slam lands; the stare bearing above wins until then.
    actor.combat.targetId = 'player';
    emitInfernoVisual(context.tickEvents, {
      // Which side the game whips from is not sourced: simulator policy alternates, left first
      // (docs/encounters/zulrah-open-questions.md).
      animations: [
        { actorId: actor.id, clipId: state.attacksMade % 2 === 1 ? 'tailLeft' : 'tailRight', delayCycles: 0 },
      ],
      projectiles: [],
      graphics: [],
    });
  }
}

/** Spits a barrage: the encounter places the clouds, this sends an orb to each. */
function spitClouds(
  actor: NpcActor,
  state: ZulrahActorState,
  config: ZulrahDefinitionConfig,
  context: NpcDefinitionContext,
): void {
  scheduleNpcAction(actor.combat, context.tick, ZULRAH_ATTACK_SPEED_TICKS);
  state.lastImpactTick = context.tick + ZULRAH_CLOUD.flightTicks;
  const tiles = config.launchCloudBarrage(actor, context);
  if (tiles.length === 0) return;
  // Reported from play: Zulrah turns to each barrage as it spits, rather than watching the player. It
  // holds that bearing until its next attack (`takeAttack`) or form change clears it.
  const aim: Coordinate = [
    tiles.reduce((sum, tile) => sum + tile[0], 0) / tiles.length,
    tiles.reduce((sum, tile) => sum + tile[1], 0) / tiles.length,
  ];
  actor.actionFacing = facingToward(actor, aim);
  const endDelayCycles = ZULRAH_CLOUD.flightTicks * 30;
  emitInfernoVisual(context.tickEvents, {
    animations: [{ actorId: actor.id, clipId: 'attack', delayCycles: 0 }],
    projectiles: tiles.map((tile) => ({
      spotAnimId: ZULRAH_CLOUD_ORB_SPOTANIM_ID,
      sourcePosition: npcProjectileSource(actor),
      target: { kind: 'tile', position: [tile[0], tile[1]] },
      startDelayCycles: 20,
      endDelayCycles,
      slope: 32,
      startOffset: 64,
      startHeight: 220,
      endHeight: 0,
    })),
    graphics: [],
  });
}

/** Spits a white orb; the encounter spawns the snakeling where it lands. */
function spitSnakelingOrb(
  actor: NpcActor,
  state: ZulrahActorState,
  config: ZulrahDefinitionConfig,
  context: NpcDefinitionContext,
): void {
  scheduleNpcAction(actor.combat, context.tick, ZULRAH_ATTACK_SPEED_TICKS);
  state.lastImpactTick = context.tick + SNAKELING.orbFlightTicks;
  const tile = config.launchSnakelingOrb(actor, context);
  if (!tile) return;
  // It faces the orb's target tile, and holds that bearing until its next attack or form change
  // (private gameplay capture zulrah-packet-data-1.txt, every snakeling orb, e.g. t323).
  actor.actionFacing = facingToward(actor, tile);
  emitInfernoVisual(context.tickEvents, {
    animations: [{ actorId: actor.id, clipId: 'attack', delayCycles: 0 }],
    projectiles: [
      {
        spotAnimId: ZULRAH_SNAKELING_ORB_SPOTANIM_ID,
        sourcePosition: npcProjectileSource(actor),
        target: { kind: 'tile', position: [tile[0], tile[1]] },
        startDelayCycles: 20,
        endDelayCycles: SNAKELING.orbFlightTicks * 30,
        slope: 32,
        startOffset: 64,
        startHeight: 220,
        endHeight: 0,
      },
    ],
    graphics: [],
  });
}

/** The bearing Zulrah surfaces on at `position`, toward `ZULRAH_SURFACE_FACING_TILE`. */
function surfaceFacing(position: Coordinate): number {
  return facingToward({ position, size: ZULRAH_SIZE }, ZULRAH_SURFACE_FACING_TILE);
}

/** OSRS angle (0 south, 512 west, 1024 north, 1536 east) from the NPC's centre to a tile's centre. */
function facingToward(actor: Pick<NpcActor, 'position' | 'size'>, tile: Coordinate): number {
  const deltaX = tile[0] + 0.5 - (actor.position[0] + actor.size / 2);
  const deltaY = tile[1] + 0.5 - (actor.position[1] + actor.size / 2);
  return (Math.round(Math.atan2(-deltaX, -deltaY) * (2048 / (2 * Math.PI))) + 2048) % 2048;
}

/** The tail hits the locked tile and every tile within `ZULRAH_TAIL.radius` of it. */
export function isInTailArea(position: Coordinate, target: Coordinate): boolean {
  return Math.max(Math.abs(position[0] - target[0]), Math.abs(position[1] - target[1])) <= ZULRAH_TAIL.radius;
}

/** Whether the player stands on a pillar tile the tail cannot reach from where Zulrah is. */
export function isTailSafeTile(zulrah: Coordinate, position: Coordinate): boolean {
  const { zulrah: spot, tiles } = ZULRAH_TAIL_SAFE_TILES;
  if (zulrah[0] !== spot[0] || zulrah[1] !== spot[1]) return false;
  return tiles.some((tile) => tile[0] === position[0] && tile[1] === position[1]);
}

function projectileCue(actor: NpcActor, target: PlayerActor, style: ZulrahStyle): NpcProjectileCue {
  const endDelayCycles = calculateProjectileEndTime(ZULRAH_PROJECTILE_TIMING, projectileDistance(actor, target));
  return {
    spotAnimId: SPOTANIM_BY_STYLE[style],
    sourcePosition: npcProjectileSource(actor),
    target: actorVisualTarget(target),
    startDelayCycles: Math.min(ZULRAH_PROJECTILE_TIMING.delay, endDelayCycles),
    endDelayCycles,
    slope: 16,
    startOffset: ZULRAH_PROJECTILE_TIMING.progress,
    // Simulator policy: launched from high on the serpent, landing at chest height.
    startHeight: 220,
    endHeight: 100,
  };
}

export function createZulrahActor(input: CreateZulrahActorInput) {
  const npcTypeId = ZULRAH_NPC_ID_BY_FORM[input.form];
  const formulaStats = getMonsterFormulaStats(npcTypeId);
  if (formulaStats === undefined) throw new TypeError(`Missing Zulrah formula stats for ${npcTypeId}`);
  const targetableFromTick = input.spawnTick + input.emergeTicks;
  const actor: NpcActor = {
    id: input.id,
    kind: 'npc',
    role: 'boss',
    alive: true,
    position: [input.position[0], input.position[1]],
    previousPosition: [input.position[0], input.position[1]],
    facing: 0,
    size: ZULRAH_SIZE,
    vitals: { hp: input.hp, maxHp: input.maxHp },
    npcTypeId,
    archetypeId: 'zulrah',
    spawnTick: input.spawnTick,
    targetableFromTick,
    history: new Map<TickNumber, Coordinate>(),
    actionFacing: surfaceFacing(input.position),
    combat: {
      attackSpeed: ZULRAH_ATTACK_SPEED_TICKS,
      attackRange: 20,
      attackStyle: input.form === 'tanzanite' ? 'magic' : 'range',
      nextActionTick: input.spawnTick + (input.firstTurnDelayTicks ?? input.emergeTicks),
      // No target until its first attack (`takeAttack`); until its first action it holds
      // `ZULRAH_SURFACE_FACING_TILE`.
      targetId: null,
      lastAttackTick: null,
      animations: { idle: null, walk: null, run: null, attack: null, death: null },
    },
    formulaStats,
    incomingHitCap: ZULRAH_HIT_CAP,
  };
  return zulrahDefinition.createActor(actor, {
    form: input.form,
    mode: input.mode,
    jadOpening: input.jadOpening ?? 'range',
    actions: [...input.actions],
    attacksMade: 0,
    lastImpactTick: null,
    pendingTail: null,
  });
}

/**
 * Turns the one Zulrah actor into its next form at its next spot, as the game does: Zulrah is a single
 * NPC that changes type (W: it "changes forms by diving into the swamp and resurfacing somewhere
 * else"). Keeping the actor keeps its HP and every hit already in flight at it.
 */
export function transformZulrah(actor: NpcActor, input: Omit<CreateZulrahActorInput, 'id' | 'hp' | 'maxHp'>): void {
  const state = zulrahDefinition.getState(actor);
  if (!state) throw new TypeError(`${actor.id} is not a Zulrah`);
  const npcTypeId = ZULRAH_NPC_ID_BY_FORM[input.form];
  const formulaStats = getMonsterFormulaStats(npcTypeId);
  if (formulaStats === undefined) throw new TypeError(`Missing Zulrah formula stats for ${npcTypeId}`);
  const targetableFromTick = input.spawnTick + input.emergeTicks;
  actor.npcTypeId = npcTypeId;
  actor.formulaStats = formulaStats;
  actor.position = [input.position[0], input.position[1]];
  actor.previousPosition = [input.position[0], input.position[1]];
  actor.spawnTick = input.spawnTick;
  actor.targetableFromTick = targetableFromTick;
  actor.hidden = false;
  actor.actionFacing = surfaceFacing(input.position);
  actor.combat.attackStyle = input.form === 'tanzanite' ? 'magic' : 'range';
  actor.combat.nextActionTick = input.spawnTick + (input.firstTurnDelayTicks ?? input.emergeTicks);
  actor.combat.lastAttackTick = null;
  state.form = input.form;
  state.mode = input.mode;
  state.jadOpening = input.jadOpening ?? 'range';
  state.actions = [...input.actions];
  state.attacksMade = 0;
  state.lastImpactTick = null;
  state.pendingTail = null;
}

export function getZulrahState(actor: NpcActor): ZulrahActorState | null {
  return zulrahDefinition.getState(actor);
}
