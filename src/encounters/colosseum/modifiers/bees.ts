import type { EncounterModifierTier } from '../../../core/encounters/encounterFactory';
import type { EnvironmentalDamage } from '../../../core/encounters/types';
import { emitEncounterVisual } from '../../../core/events/encounterVisual';
import { reviveNpc } from '../../../core/npcDeath';
import { isArenaFootprintWalkable } from '../../../core/npcMovementCollision';
import { findNpcTileRoute, isCoordinateInsideFootprint } from '../../../core/npcRouteFinding';
import { createNpcDefinition, type DefinedNpcActor } from '../../../core/npcs';
import { createColosseumActor } from '../../../npcs/colosseum/actors';
import type { Coordinate } from '../../../types/simulation';

export const BEES_DAMAGE_SOURCE = 'Bees';
export const BEE_STEP_INTERVAL_TICKS = 2;
/** VERIFIED grid in all 320 A/B crawls: six potential steps, then choose a fresh destination. */
export const BEE_WINDOW_TICKS = 12;
/** MODEL: smallest SW-centered square covering reached-window offsets, including B's +6 X. */
export const BEE_DESTINATION_RADIUS = 6;
/** MODEL: killing-hit -> teleport spans 3–6 in B; +5 fits B:3117->3122 and 4 other samples. */
export const BEE_DEATH_TELEPORT_TICKS = 5;
/** VERIFIED: every complete teleport -> first crawl interval in B is +55 (10 samples). */
export const BEE_RESPAWN_PAUSE_TICKS = 55;

/**
 * MODEL: distinct draws from the nine observed tiles, not a recovered spawn distribution.
 * B wave 5–8 spawns and A:4984, converted by Colosseum origin (1792,3072); no axis flip.
 */
export const COLOSSEUM_BEE_SPAWN_TILES: readonly Readonly<Coordinate>[] = [
  [26, 30],
  [34, 32],
  [31, 39],
  [37, 34],
  [38, 32],
  [38, 36],
  [34, 38],
  [37, 32],
  [36, 38],
];

interface BeeState {
  readonly spawnPosition: Coordinate;
  nextStepTick: number;
  nextWindowTick: number;
  destination: Coordinate | null;
  teleportAt: number | null;
  resumeAt: number | null;
  /** Tick of the killing hit; the swarm still stings once on the following tick (B:3402->3403). */
  defeatedTick: number | null;
}
export type BeeActor = DefinedNpcActor<BeeState>;

export const canBeeOccupy = isArenaFootprintWalkable;

function chooseDestination(player: Coordinate, size: number, random: () => number): Coordinate | null {
  const candidates: Coordinate[] = [];
  for (let dx = -BEE_DESTINATION_RADIUS; dx <= BEE_DESTINATION_RADIUS; dx++) {
    for (let dy = -BEE_DESTINATION_RADIUS; dy <= BEE_DESTINATION_RADIUS; dy++) {
      const tile: Coordinate = [player[0] + dx, player[1] + dy];
      if (canBeeOccupy(tile, size)) candidates.push(tile);
    }
  }
  // Equivalent to rerolling invalid footprints, without an unbounded loop.
  return candidates.length === 0 ? null : candidates[Math.floor(random() * candidates.length)]!;
}

export const beesDefinition = createNpcDefinition<BeeState, undefined>({
  id: 'colosseum-bees',
  onDefeated: ({ actor, defeat }) => {
    actor.state.teleportAt = defeat.tick + BEE_DEATH_TELEPORT_TICKS;
    actor.state.defeatedTick = defeat.tick;
    actor.state.resumeAt = null;
    actor.state.destination = null;
    // The cache-backed death clip is 10824. Keep the actor for its own respawn, not a new swarm.
  },
  move: ({ actor, context }) => {
    const player = context.world.getPlayer();
    if (!actor.alive || !player?.alive) return [];
    const state = actor.state;
    if (context.tick >= state.nextWindowTick) {
      const start =
        state.nextWindowTick + BEE_WINDOW_TICKS * Math.floor((context.tick - state.nextWindowTick) / BEE_WINDOW_TICKS);
      state.nextWindowTick = start + BEE_WINDOW_TICKS;
      state.nextStepTick = start;
      // A:4985 moves away from the player; B:3102 retains its destination through a pillar detour.
      state.destination = chooseDestination(player.position, actor.size, context.random);
    }
    if (context.tick < state.nextStepTick || (context.tick - state.nextStepTick) % BEE_STEP_INTERVAL_TICKS !== 0) {
      return [];
    }
    state.nextStepTick = context.tick + BEE_STEP_INTERVAL_TICKS;
    if (!state.destination) return [];
    // Fixed destination, not a live chase or under-player hold. Static arena collision only;
    // neither footprint occupancy nor the route checks other NPCs.
    const route = findNpcTileRoute({
      source: actor.position,
      destination: state.destination,
      size: actor.size,
      canOccupy: canBeeOccupy,
      moveNear: false,
    });
    const next = route.kind === 'exact' ? route.steps[0] : undefined;
    if (!next) return [];
    return [{ npcId: actor.id, path: [next] }];
  },
  resolveLocalEffects: ({ actor, context }) => {
    const player = context.world.getPlayer();
    // CAPTURE-FIT: a swarm killed on tick K still stings on K+1 (B:3402 kill, B:3403 sting) and not
    // from K+2 (B:2694, B:3404). With this, all 15 stings in B are reproduced.
    const lastSting = !actor.alive && actor.state.defeatedTick === context.tick - 1;
    if ((!actor.alive && !lastSting) || !player?.alive || actor.spawnTick === context.tick) return [];
    // The engine sets previousPosition before NPC movement; player movement has not run yet.
    // B:3098/3109/3127–3132/3400 fit the SW-anchored 2x2 footprint, without engagement state.
    // B:3105/3125 enter only after movement, so must not sting on that tick.
    const footprint = actor.alive ? actor.previousPosition : actor.position;
    if (!isCoordinateInsideFootprint(footprint, actor.size, player.position)) return [];
    emitEncounterVisual(context.tickEvents, {
      animations: [{ actorId: actor.id, clipId: 'attack', delayCycles: 0 }],
      projectiles: [],
      graphics: [],
    });
    const protectedByAntipoison = player.poisonState.poisonVarp < 0;
    const damage: EnvironmentalDamage = {
      // B tier II: 5..10 while antipoison AND Relentless III were active. Same range at every tier.
      // Without antipoison: 10..20 MODEL (Wiki Bee Swarm oldid=15211088 says antipoison halves it).
      baseDamage: protectedByAntipoison ? [5, 10] : [10, 20],
      attackType: 'typeless',
      source: BEES_DAMAGE_SOURCE,
      playerPosition: [...player.position],
      // Existing ordinary-poison scale: ceil(severity/5); severity 5 starts at one damage.
      ...(!protectedByAntipoison ? { applyPoison: 5 } : {}),
    };
    // Cache hitsplat 65 has no mapped HitsplatType; use the existing ordinary damage splat.
    return [damage];
  },
});

/** Called before NPC movement so the first resumed crawl can occur exactly at teleport+55. */
export function advanceBeeRespawn(actor: BeeActor, tick: number): void {
  const state = actor.state;
  if (state.teleportAt !== null && tick >= state.teleportAt) {
    actor.position = [...state.spawnPosition];
    actor.previousPosition = [...state.spawnPosition];
    actor.movementPath = [];
    state.resumeAt = state.teleportAt + BEE_RESPAWN_PAUSE_TICKS;
    state.teleportAt = null;
  }
  if (state.resumeAt !== null && tick >= state.resumeAt) {
    // A new life: the death record goes, and hits queued against the last life cannot land on this one.
    reviveNpc(actor);
    state.defeatedTick = null;
    actor.vitals.hp = actor.vitals.maxHp;
    actor.despawnTick = undefined;
    actor.debuffs = undefined;
    state.nextStepTick = state.resumeAt;
    state.nextWindowTick = state.resumeAt;
    state.destination = null;
    state.resumeAt = null;
  }
}

export function createBeeSwarms(input: {
  readonly tier: EncounterModifierTier;
  readonly tick: number;
  readonly idPrefix: string;
  readonly random: () => number;
}): BeeActor[] {
  const available = COLOSSEUM_BEE_SPAWN_TILES.map((tile): Coordinate => [...tile]);
  return Array.from({ length: input.tier }, (_, index) => {
    const position = available.splice(Math.floor(input.random() * available.length), 1)[0]!;
    return beesDefinition.createActor(
      { ...createColosseumActor('bees', `${input.idPrefix}_${index}`, position), spawnTick: input.tick },
      {
        spawnPosition: [...position],
        nextStepTick: input.tick + 1,
        nextWindowTick: input.tick + 1,
        destination: null,
        teleportAt: null,
        resumeAt: null,
        defeatedTick: null,
      },
    );
  });
}
