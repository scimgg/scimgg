import type { NpcActor } from '../../../core/actors/NpcActor';
import type { PlayerActor } from '../../../core/actors/PlayerActor';
import { setArenaConfig } from '../../../core/constants';
import type { EncounterContext, EncounterTickResult, EnvironmentalDamage } from '../../../core/encounters/types';
import { TickEvents } from '../../../core/events/TickEvents';
import { NpcDefinitionCollection, type NpcDefinitionContext } from '../../../core/npcs';
import { SimulationEngine } from '../../../core/SimulationEngine';
import type { WorldState } from '../../../core/WorldState';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { SolHereditEncounter } from '../../../encounters/solHeredit/SolHereditEncounter';
import { CollisionFlag } from '../../../rs/collision/CollisionFlag';
import { createCollisionMap } from '../../../rs/collision/WalkabilityAnalyzer';
import type { Coordinate } from '../../../types/simulation';
import { javelinColossusDefinition, landJavelinArtillery } from '../javelinColossus';
import { shockwaveColossusDefinition } from '../shockwaveColossus';

/** Shared fixtures for the colossus suites; no game data. */

/** The Colosseum's north-west pillar (cache LOC 52490 at local (24, 41)), alone on an open floor. */
export const PILLAR_SW: Coordinate = [24, 41];

export function installPillarArena(): void {
  const map = createCollisionMap(64, 64);
  for (let dx = 0; dx < 3; dx++) {
    for (let dy = 0; dy < 3; dy++) {
      map.flag(PILLAR_SW[0] + dx, PILLAR_SW[1] + dy, CollisionFlag.OBJECT | CollisionFlag.OBJECT_PROJECTILE_BLOCKER);
    }
  }
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: map }, true);
}

export function resetArena(): void {
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
}

/** A world holding only the player at `playerTile`, with an open floor and the one pillar. */
export function colossusWorld(playerTile: Coordinate): { world: WorldState; player: PlayerActor } {
  const world = new SimulationEngine({ encounter: new SolHereditEncounter(1) })['worldState'];
  installPillarArena();
  const player = world.getPlayer()!;
  world.actors.clear();
  world.occupancy.clear();
  world.actors.set(player.id, player);
  player.position = [...playerTile];
  return { world, player };
}

export function definitionContext(
  world: WorldState,
  tick: number,
  random: () => number = () => 0.5,
): NpcDefinitionContext {
  return {
    tick,
    world,
    tickEvents: new TickEvents(),
    random,
    spawnNpc: () => undefined,
    despawnNpc: () => undefined,
    logEvent: () => undefined,
  };
}

/**
 * One colossus through the real engine, wired as the wave owner must: its definition moves and acts in its
 * own turn, and a javelin's released artillery lands from `resolveHazards`.
 */
export class ColossusEngineEncounter extends LobbyEncounter {
  private readonly definitions = new NpcDefinitionCollection([
    javelinColossusDefinition.register(undefined),
    shockwaveColossusDefinition.register(undefined),
  ]);

  constructor(
    private readonly colossus: NpcActor,
    private readonly random: () => number,
  ) {
    super();
  }

  override createNpcs(): NpcActor[] {
    return [this.colossus];
  }

  getNpcDefinitions(): NpcDefinitionCollection {
    return this.definitions;
  }

  override resolveHazards(ctx: EncounterContext): EnvironmentalDamage[] {
    return javelinColossusDefinition.isActor(this.colossus)
      ? landJavelinArtillery(this.colossus, { ...ctx, random: this.random })
      : [];
  }

  processNpcTick(actor: NpcActor, ctx: EncounterContext): EncounterTickResult {
    return this.definitions.tick(actor, { ...ctx, random: this.random });
  }
}

export function colossusEngine(colossus: NpcActor, playerTile: Coordinate, random: () => number): SimulationEngine {
  const engine = new SimulationEngine({
    encounter: new ColossusEngineEncounter(colossus, random),
    startPos: playerTile,
  });
  installPillarArena();
  engine.setMechanicsConfig({ infiniteHealth: true });
  return engine;
}

/** Advances until `tick` has been processed, the player standing on `tile`. */
export function runEngineTo(engine: SimulationEngine, tick: number, tile: Coordinate): void {
  while (engine.currentTick < tick) engine.advanceTick(tile);
}
