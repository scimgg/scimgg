import { type NpcActor, submergeNpc, surfaceNpc } from '../../core/actors/NpcActor';
import { isNpcActionReady, scheduleNpcAction } from '../../core/combat/npcActionClock';
import { type AttackPlan, canNpcAttack, resolveAttackRequest } from '../../core/combat/npcAttackRequest';
import { createNpcRetaliation } from '../../core/combat/retaliation';
import { contextAttackDecisions, contextDecisions } from '../../core/decisionRandom';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { standardNpcCombatMove } from '../../core/npcCombatMovement';
import { canNpcActThisTurn } from '../../core/npcDeath';
import { createNpcDefinition, type NpcDefinitionContext } from '../../core/npcs';
import type { Coordinate } from '../../types/simulation';
import { createInfernoActor } from './actors';
import { emitInfernoAbility, emitZukDeath } from './events';
import { presentInfernoDamage } from './presentation';
import { resolveReadyTarget } from './targetResolution';
import { emitInfernoWaveAttack, isInfernoFootprintLegal } from './waveCombat';

const MELEER_SIZE = 4;
// docs/encounters/inferno-facts-spec.md (Behavior, Jal-ImKot): melee every 4 ticks, hit on the
// swing tick; W Jal-ImKot max 49 slash.
const MELEER_ATTACK_SPEED = 4;
const MELEER_MAX_HIT = 49;
// docs/encounters/inferno-policy.md (Meleer dig): first check spawn+50 (resurrection add+49), later
// checks every uniform 40-60 ticks (counted from the walk-again tick after a dig), skipped while the
// attack delay is within 15 ticks; down->up 3 ticks; walk from up+3 (policy); attack from up+9 (facts spec).
const FIRST_DIG_CHECK_TICKS = 50;
const FIRST_DIG_CHECK_TICKS_RESURRECTED = 49;
const DIG_RECHECK_MIN_TICKS = 40;
const DIG_RECHECK_SPAN_TICKS = 21;
// Jagex (Arcane): no dig while the "attack delay is within 15 cycles"; the delay is its last swing plus
// its attack speed. Captures bound the swing-to-check window to 18-23 (P t7349 suppressed 18 after a
// swing at t7331; Q t1884 dug 24 after t1860); the inclusive reading (19) is policy.
const DIG_ATTACK_DELAY_WINDOW_TICKS = 15;
const DIG_SUPPRESSED_AFTER_ATTACK_TICKS = MELEER_ATTACK_SPEED + DIG_ATTACK_DELAY_WINDOW_TICKS;
const DIG_DURATION_TICKS = 3;
const WALK_AFTER_UP_TICKS = 3;
// Facts spec (Jal-ImKot): first attack after a resurface no earlier than up+9 (17/25 exactly +9, none
// +6..+8; P:159912-160148, P:155672-155781).
const ATTACK_AFTER_UP_TICKS = 9;
/** How far past a fully blocked set of player-containing footprints the resurface search reaches. */
const RESURFACE_SEARCH_RADIUS = 8;

const MELEE_PLAN = {
  formulaStyle: 'melee_slash',
  damageType: 'melee',
  attackKind: 'melee_slash',
  impactDelayTicks: 0,
  maxHit: MELEER_MAX_HIT,
  // Lands on the swing tick, so it is never queued.
  sourceDeathPolicy: 'cancel-before-impact',
} as const satisfies AttackPlan;

export type MeleerState = {
  readonly firstActionTick: number;
  nextDigCheckTick: number;
  /**
   * The dig in progress: down on `downTick`, resurfaced on `downTick + 3` around `target`, the player's
   * tile at the start of the down tick.
   */
  dig: { readonly downTick: number; readonly target: Coordinate | null } | null;
  /** Earliest step after the last resurface (from the add tick, the engine decides). */
  walkFromTick: number;
};

type MeleerActor = NpcActor & { readonly state: MeleerState };

/**
 * Player-containing 4x4 footprints in preference order. Captured resurfaces put the player's tile from
 * the start of the dig-down tick on the NE corner (25/42 P+Q telejumps) or, when that is blocked, on the
 * SW corner (16/42), and once on (1,1) (P t1145, both corners blocked); the order of the rest is policy.
 */
const CONTAINING_OFFSETS: readonly Coordinate[] = [
  [3, 3],
  [0, 0],
  ...[1, 2, 0, 3]
    .flatMap((y) => [1, 2, 0, 3].map((x): Coordinate => [x, y]))
    .filter(([x, y]) => !(x === 3 && y === 3) && !(x === 0 && y === 0)),
];

/**
 * Policy (Meleer dig): the footprint containing `playerTile` (the dig-down snapshot), else the nearest
 * legal one. It may overlap other NPCs (a bat P:152815-152827, a mager Q:81854-81857); only terrain and
 * standing pillars rule a footprint out. No capture has every containing footprint illegal, so the
 * nearest-legal fallback is policy.
 */
export function meleerResurfacePosition(actor: Pick<NpcActor, 'position'>, playerTile: Coordinate): Coordinate {
  const free = (southWest: Coordinate) => isInfernoFootprintLegal(southWest, MELEER_SIZE);
  for (const [x, y] of CONTAINING_OFFSETS) {
    const southWest: Coordinate = [playerTile[0] - x, playerTile[1] - y];
    if (free(southWest)) return southWest;
  }
  // Every SW anchor whose footprint sits `radius` tiles from the player, rows north to south, each
  // west to east: anchors span [p - 3 - radius, p + radius] on both axes.
  for (let radius = 1; radius <= RESURFACE_SEARCH_RADIUS; radius++) {
    for (let y = playerTile[1] + radius; y >= playerTile[1] - MELEER_SIZE + 1 - radius; y--) {
      for (let x = playerTile[0] - MELEER_SIZE + 1 - radius; x <= playerTile[0] + radius; x++) {
        const gapX = Math.max(x - playerTile[0], 0, playerTile[0] - (x + MELEER_SIZE - 1));
        const gapY = Math.max(y - playerTile[1], 0, playerTile[1] - (y + MELEER_SIZE - 1));
        if (Math.max(gapX, gapY) === radius && free([x, y])) return [x, y];
      }
    }
  }
  return [...actor.position];
}

/** Drawn at every check, a suppressed one included (`inferno.meleer.dig_interval`, 0-20 above the minimum). */
function rollDigInterval(actor: NpcActor, tick: number, context: NpcDefinitionContext): number {
  const key = { site: 'inferno.meleer.dig_interval', tick, actorId: actor.id };
  return DIG_RECHECK_MIN_TICKS + contextDecisions(context).int(key, 0, DIG_RECHECK_SPAN_TICKS - 1);
}

function emitClip(actor: NpcActor, clipId: string, context: NpcDefinitionContext): void {
  emitEncounterVisual(context.tickEvents, {
    animations: [{ actorId: actor.id, clipId, delayCycles: 0 }],
    projectiles: [],
    graphics: [],
  });
}

/** Runs first in the meleer's turn (from `move`), so a dig starting or ending this tick takes no step. */
function advanceDig(actor: MeleerActor, context: NpcDefinitionContext): void {
  const state = actor.state;
  const dig = state.dig;
  if (dig !== null) {
    if (context.tick < dig.downTick + DIG_DURATION_TICKS) return;
    const position = dig.target ? meleerResurfacePosition(actor, dig.target) : [...actor.position];
    actor.position = [position[0], position[1]];
    actor.previousPosition = [position[0], position[1]];
    actor.movementPath = [];
    state.dig = null;
    surfaceNpc(actor);
    state.walkFromTick = context.tick + WALK_AFTER_UP_TICKS;
    actor.combat.nextActionTick = Math.max(actor.combat.nextActionTick, context.tick + ATTACK_AFTER_UP_TICKS);
    emitClip(actor, 'dig_up', context);
    emitInfernoAbility(context, { ability: 'meleer_dig_up', actorId: actor.id, position: actor.position });
    return;
  }
  if (context.tick < state.nextDigCheckTick) return;
  // Its own last swing, not `nextActionTick`: retaliation flinch-pushes that on player hits, and captured
  // hits do not block a dig (P t9229-9235 then dig t9236; Q t1880/1882 then dig t1884).
  const lastAttack = actor.combat.lastAttackTick;
  const interval = rollDigInterval(actor, context.tick, context);
  if (lastAttack !== null && context.tick - lastAttack <= DIG_SUPPRESSED_AFTER_ATTACK_TICKS) {
    state.nextDigCheckTick = context.tick + interval;
    return;
  }
  // After a dig the interval counts from the walk-again tick (down+6): captured dig-to-dig gaps run
  // 46-65 (P t9074-9120 = 6+40; P t9171-9236 = 65 is out of reach counting from the down tick).
  state.nextDigCheckTick = context.tick + DIG_DURATION_TICKS + WALK_AFTER_UP_TICKS + interval;
  // Facts spec (Jal-ImKot): the resurface is placed around the player's tile at the start of the DOWN
  // tick (42/42 P+Q; the up-tick tile misses e.g. P t3020, t8082, t9077, Q t1657). The NPC band runs
  // before player movement, so `position` is still that tile.
  const player = context.world.getPlayer();
  state.dig = { downTick: context.tick, target: player ? [player.position[0], player.position[1]] : null };
  // Underground until the up tick: nothing new can target it; its old footprint still blocks (P:159828-159955).
  submergeNpc(actor, context.tick + DIG_DURATION_TICKS);
  emitClip(actor, 'dig_down', context);
  emitInfernoAbility(context, { ability: 'meleer_dig_down', actorId: actor.id, position: actor.position });
}

export const meleerDefinition = createNpcDefinition<MeleerState, undefined>({
  id: 'inferno-jal-imkot',
  deathPolicy: 'queued',
  onDamageResolved: presentInfernoDamage,
  // Facts spec (NPCs table) death sequence; its sound rides the same tick (zukAudioRules).
  onDeathAnimation: ({ actor, context }) =>
    emitZukDeath(context, { actorId: actor.id, npcKind: 'meleer', position: actor.position }),
  onDeathStarted: ({ actor }) => {
    if (actor.state.dig !== null) surfaceNpc(actor);
    actor.state.dig = null;
  },
  move: ({ actor, context }) => {
    if (!canNpcActThisTurn(actor, context.tick)) return [];
    const wasDigging = actor.state.dig !== null;
    advanceDig(actor, context);
    if (wasDigging || actor.state.dig !== null || context.tick < actor.state.walkFromTick) return [];
    return standardNpcCombatMove(actor, context);
  },
  tick: ({ actor, context }) => {
    const empty = { environmentalDamages: [] };
    // No attack while underground; the resurface itself pushes `nextActionTick` to up+9.
    if (!canNpcActThisTurn(actor, context.tick) || actor.state.dig !== null) return empty;
    if (context.tick < actor.state.firstActionTick || !isNpcActionReady(actor.combat, context.tick)) return empty;
    const target = resolveReadyTarget(actor, context.world);
    if (!target || !canNpcAttack(actor, target, MELEE_PLAN)) return empty;
    const attack = resolveAttackRequest({
      attacker: actor,
      target,
      plan: MELEE_PLAN,
      random: context.random,
      labelled: contextAttackDecisions(context),
    });
    if (!attack) throw new TypeError(`Missing formula stats for ${actor.id} or ${target.id}`);
    emitInfernoWaveAttack(context, { actor, target, clipId: 'attack', kind: 'meleer_melee', impactDelayTicks: 0 });
    actor.combat.lastAttackTick = context.tick;
    scheduleNpcAction(actor.combat, context.tick, MELEER_ATTACK_SPEED);
    return { environmentalDamages: [], npcAttacks: [attack] };
  },
});

export function createMeleer(options: {
  readonly id: string;
  readonly position: Coordinate;
  readonly spawnTick: number;
  readonly targetId: string | null;
  readonly resurrected?: boolean;
  readonly initialDelayTicks?: number;
}) {
  const actor = createInfernoActor('meleer', options.id, options.position);
  actor.spawnTick = options.spawnTick;
  actor.combat.attackSpeed = MELEER_ATTACK_SPEED;
  actor.combat.attackRange = 1;
  actor.combat.attackStyle = 'melee';
  actor.combat.targetId = options.targetId;
  actor.combat.retaliation = createNpcRetaliation();
  return meleerDefinition.createActor(actor, {
    firstActionTick: options.spawnTick + (options.initialDelayTicks ?? 1),
    nextDigCheckTick:
      options.spawnTick + (options.resurrected ? FIRST_DIG_CHECK_TICKS_RESURRECTED : FIRST_DIG_CHECK_TICKS),
    dig: null,
    walkFromTick: options.spawnTick,
  });
}
