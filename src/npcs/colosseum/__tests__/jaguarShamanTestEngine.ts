import type { NpcActor } from '../../../core/actors/NpcActor';
import type { ArenaConfig } from '../../../core/arena/ArenaConfig';
import { setArenaConfig } from '../../../core/constants';
import type { EncounterContext, EncounterTickResult } from '../../../core/encounters/types';
import { type EncounterVisualEvent, isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { type GameEvent, isCoreEvent } from '../../../core/events/types';
import { NpcDefinitionCollection } from '../../../core/npcs';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { CollisionFlag } from '../../../rs/collision/CollisionFlag';
import { createCollisionMap } from '../../../rs/collision/WalkabilityAnalyzer';
import type { Coordinate } from '../../../types/simulation';
import { jaguarWarriorDefinition } from '../jaguarWarrior';
import { serpentShamanDefinition } from '../serpentShaman';
import { COLOSSEUM_PILLAR_SOUTH_WEST_TILES } from './fixtures/serpentShamanCapture';

/**
 * The production shaman and jaguar definitions in the real engine, each in its own NPC turn, over
 * the arena's four pillars. Other NPCs from a capture are stand-in occupants that never act, removed
 * on the tick the capture deletes them. Nothing removes a dead shaman or jaguar: that is the wave
 * owner's (`ColosseumWaveRun.removeNpcIfDue`), covered by its own tests.
 */
class WaveNpcTestEncounter extends LobbyEncounter {
  private readonly definitions = new NpcDefinitionCollection([
    serpentShamanDefinition.register(undefined),
    jaguarWarriorDefinition.register(undefined),
  ]);
  /** The definitions' rolls: accuracy then damage, per hit. */
  random: () => number = () => 0.5;

  constructor(
    private readonly npcs: readonly NpcActor[],
    private readonly removals: ReadonlyMap<string, number>,
  ) {
    super();
  }

  override createNpcs(): NpcActor[] {
    return [...this.npcs];
  }

  getNpcDefinitions(): NpcDefinitionCollection {
    return this.definitions;
  }

  processNpcTick(actor: NpcActor, ctx: EncounterContext): EncounterTickResult {
    return this.definitions.tick(actor, { ...ctx, random: this.random });
  }

  removeNpcIfDue(actor: NpcActor, ctx: EncounterContext): void {
    const scripted = this.removals.get(actor.id);
    if (scripted !== undefined && ctx.tick >= scripted) ctx.despawnNpc(actor.id);
  }
}

export function colosseumPillarCollision() {
  const collision = createCollisionMap(64, 64);
  for (const [sx, sy] of COLOSSEUM_PILLAR_SOUTH_WEST_TILES) {
    for (let x = sx; x < sx + 3; x++) {
      for (let y = sy; y < sy + 3; y++)
        collision.flag(x, y, CollisionFlag.OBJECT | CollisionFlag.OBJECT_PROJECTILE_BLOCKER);
    }
  }
  return collision;
}

/** A capture NPC that only occupies its tiles. */
export function standInOccupant(id: string, npcTypeId: number, position: Readonly<Coordinate>, size: number): NpcActor {
  return {
    id,
    kind: 'npc',
    npcTypeId,
    archetypeId: 'capture_stand_in',
    size,
    alive: true,
    position: [...position],
    previousPosition: [...position],
    facing: 0,
    vitals: { hp: 100, maxHp: 100 },
    history: new Map(),
    combat: {
      attackSpeed: 5,
      attackRange: 0,
      attackStyle: 'melee',
      nextActionTick: 0,
      targetId: null,
      lastAttackTick: null,
      animations: { idle: null, walk: null, run: null, attack: null, death: null },
    },
  };
}

export function clearArena(): void {
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
}

/** `npcs` take their turns in this order, as capture NPC indices do. */
export function startWaveNpcEngine(
  npcs: readonly NpcActor[],
  options: {
    readonly playerStart: Readonly<Coordinate>;
    readonly removals?: ReadonlyMap<string, number>;
    /** The cached wave arena; by default an open floor with the four pillars. */
    readonly arena?: ArenaConfig;
  },
) {
  const encounter = new WaveNpcTestEncounter(npcs, options.removals ?? new Map());
  const engine = new SimulationEngine({ encounter, startPos: [...options.playerStart] });
  engine.setMechanicsConfig({ infiniteHealth: true });
  // After the engine's own setup, which installs the lobby's arena.
  if (options.arena) setArenaConfig(options.arena);
  else setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: colosseumPillarCollision() }, true);
  const player = engine['worldState'].getPlayer()!;
  /** Runs one tick with the player held on `playerStart` (its start-of-tick tile); returns its events. */
  const step = (playerStart: Readonly<Coordinate>): GameEvent[] => {
    player.position = [...playerStart];
    engine.advanceTick([...playerStart]);
    return engine.getLastTickEvents();
  };
  return { engine, encounter, player, step };
}

export function playerHits(events: readonly GameEvent[]) {
  return events.flatMap((event) => (isCoreEvent(event, 'hit_applied') && event.targetId === 'player' ? [event] : []));
}

export function attackStarts(events: readonly GameEvent[], actorId: string) {
  return events.filter((event) => isCoreEvent(event, 'attack_started') && event.sourceId === actorId);
}

export function visuals(events: readonly GameEvent[]): EncounterVisualEvent[] {
  return events.filter(isEncounterVisualEvent);
}

/** Feeds the given draws in order, then 0.5. */
export function scriptedRandom(draws: number[]): () => number {
  return () => draws.shift() ?? 0.5;
}
