import { afterEach, describe, expect, it, vi } from 'vitest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import type { EncounterContext } from '../../../core/encounters/types';
import { TickEvents } from '../../../core/events/TickEvents';
import { isPlayerUnderFootprint } from '../../../core/npcPursuit';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { createCrystal } from '../../../npcs/colosseum/crystal';
import { launchSolIfReady, solDefinition } from '../../../npcs/colosseum/sol';
import { isInsideArena } from '../../../npcs/colosseum/solAttacks';
import { CollisionFlag } from '../../../rs/collision/CollisionFlag';
import { createEncounterActorOps } from '../../../test/helpers/encounterActorOps';
import { runEncounterNpcActions } from '../../../test/helpers/encounterNpcBand';
import { createUnusedPlayerControlOps } from '../../../test/helpers/playerControlStubs';
import type { Coordinate } from '../../../types/simulation';
import { SOL_ARENA, SOL_OPENING_HOLD_UNTIL_TICK, SOL_PLAYER_START, SOL_START_POSITION } from '../constants';
import { SolHereditEncounter } from '../SolHereditEncounter';
import { SOL_PURSUIT_CAPTURES } from './fixtures/solPursuitCapture';

const originalArena = getArenaConfig();
const originalFallback = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(originalArena, originalFallback));

function setup(position: Coordinate = [31, 33], target: Coordinate = [32, 30]) {
  const encounter = new SolHereditEncounter(7);
  const engine = new SimulationEngine({ encounter, combatRandom: () => 0.5 });
  const world = engine['worldState'];
  const sol = world.getNpcs().find(solDefinition.isActor);
  const player = world.getPlayer();
  if (!sol || !player) throw new Error('Missing actors');
  sol.position = position;
  player.position = target;
  const context: EncounterContext = {
    tick: 20,
    playerPos: target,
    world,
    tickEvents: new TickEvents(),
    logEvent: () => {},
    grantNextAttackSpeedup: () => {},
    ...createEncounterActorOps(world),
    ...createUnusedPlayerControlOps(),
  };
  const random = vi.fn(() => 0.5);
  // Sol's turn: the engine reconciles placements (the positions set above) before he moves.
  const move = (tick = 20) => {
    world.occupancy.reconcile(world.actors.values());
    return encounter.getNpcDefinitions().move(sol, { ...context, tick, random })[0]?.path ?? [];
  };
  return { encounter, engine, world, sol, player, context, move, random };
}

describe('Sol production pursuit capture conformance', () => {
  const locks = { spear: 6, shield: 4, grapple: 5, triple: 4 } as const;
  for (const [name, frames] of Object.entries(SOL_PURSUIT_CAPTURES)) {
    const capture = { name };
    const underfoot = (frame: (typeof frames)[number]) =>
      isPlayerUnderFootprint([...frame.beforeSol], 5, [...frame.beforePlayer]);
    it(`${capture.name}: recursively matches every conditional path and endpoint`, () => {
      const first = frames[0];
      if (!first) throw new Error('No capture frames');
      const { sol, player, move } = setup([first.beforeSol[0], first.beforeSol[1]]);
      for (const frame of frames) {
        player.position = [...frame.beforePlayer];
        sol.state.immobileUntilTick = Math.max(
          frame.attackTick + locks[frame.attack],
          (frame.phaseTick ?? Number.NEGATIVE_INFINITY) + 5,
        );
        const path = move(frame.tick);
        if (underfoot(frame)) {
          // The escape direction is a random cardinal; only its shape and timing are deterministic.
          expect(path.length, `${capture.name}${frame.tick}`).toBe(frame.path.length);
          sol.position = [...frame.sol];
          continue;
        }
        expect(path, `${capture.name}${frame.tick}`).toEqual(frame.path);
        sol.position = path.at(-1) ?? sol.position;
        expect(sol.position, `${capture.name}${frame.tick}`).toEqual(frame.sol);
      }
    });
    it.each(
      frames.filter((frame) => frame.path.length > 0 && !underfoot(frame)),
    )('matches recorded path at $tick', (frame) => {
      const { move, random } = setup([...frame.beforeSol], [...frame.beforePlayer]);
      expect(move()).toEqual(frame.path);
      expect(random).not.toHaveBeenCalled();
    });
    it.each(
      frames.filter((frame) => frame.path.length > 0 && underfoot(frame)),
    )('steps one cardinal tile out from under the player at $tick', (frame) => {
      const { move } = setup([...frame.beforeSol], [...frame.beforePlayer]);
      const [step] = move();
      expect(move()).toHaveLength(1);
      expect(Math.abs(step[0] - frame.beforeSol[0]) + Math.abs(step[1] - frame.beforeSol[1])).toBe(1);
    });
  }
});

/** Every tile of a 5x5 footprint anchored at `position`, as `x,y` keys. */
function footprintKeys([x, y]: Readonly<Coordinate>): string[] {
  return Array.from({ length: 25 }, (_, index) => `${x + (index % 5)},${y + Math.floor(index / 5)}`);
}

describe('Sol pursuit through the shared route finder', () => {
  it.each([
    {
      name: 'unequal diagonal separation [1,3] goes straight first, like the captured runs',
      target: [36, 37],
      path: [
        [31, 31],
        [32, 32],
      ],
    },
    { name: 'corner [1,1] without stepping onto player', target: [36, 35], path: [[32, 30]] },
    { name: 'cardinal adjacency', target: [33, 29], path: [] },
    {
      name: 'provisional cap with more than two steps to contact',
      target: [33, 41],
      path: [
        [31, 31],
        [31, 32],
      ],
    },
  ] satisfies { name: string; target: Coordinate; path: Coordinate[] }[])('$name', ({ target, path }) => {
    const { move, random } = setup([31, 30], target);
    expect(move()).toEqual(path);
    expect(random).not.toHaveBeenCalled();
  });

  it('steps one random cardinal tile out when the player is underneath', () => {
    const { move, random } = setup([31, 30], [33, 32]);
    expect(move()).toEqual([[31, 29]]);
    expect(random).toHaveBeenCalledTimes(2);
  });

  it('routes around terrain instead of entering it', () => {
    const { encounter, move } = setup();
    const arena = encounter.getArenaConfig();
    arena.walkableTiles?.delete('31,31');
    setArenaConfig(arena);
    const path = move();
    expect(path).toEqual([
      [31, 32],
      [32, 31],
    ]);
    for (const step of path) expect(footprintKeys(step)).not.toContain('31,31');
  });

  it.each([31, 32])('checks directional wall flags on leading edge y=%s', (wallY) => {
    const { encounter, move } = setup();
    const flagAt = (x: number, y: number) => (x === 33 && y === wallY ? CollisionFlag.WALL_NORTH : 0);
    setArenaConfig({
      ...encounter.getArenaConfig(),
      collisionMap: {
        sizeX: 64,
        sizeY: 64,
        flags: new Int32Array(64 * 64),
        getFlag: flagAt,
        hasFlag: (x, y, mask) => (flagAt(x, y) & mask) !== 0,
        flag: () => {},
        unflag: () => {},
      },
    });
    // The direct route crosses the wall, so Sol goes round it to the west.
    expect(move()).toEqual(
      wallY === 31
        ? [
            [30, 33],
            [29, 32],
          ]
        : [
            [30, 33],
            [29, 33],
          ],
    );
  });

  it('falls back vertically when diagonal and horizontal leading edges are blocked', () => {
    const { encounter, move } = setup([31, 30], [36, 37]);
    const arena = encounter.getArenaConfig();
    arena.walkableTiles?.delete('36,33');
    setArenaConfig(arena);
    expect(move()).toEqual([
      [31, 31],
      [31, 32],
    ]);
  });

  // A dying actor keeps its tiles until it is removed from the world (`npcOccupancy.ts`).
  it.each(['alive', 'dead', 'removed'] as const)('checks %s actors at the second leading edge', (status) => {
    const { world, move } = setup();
    const blocker = createCrystal({ id: 'blocker', index: 0, tick: 0, charging: false });
    blocker.position = [31, 31];
    blocker.alive = status !== 'dead';
    if (status !== 'removed') world.actors.set(blocker.id, blocker);
    expect(move()).toEqual(
      status !== 'removed'
        ? [
            [31, 32],
            [32, 31],
          ]
        : [
            [31, 32],
            [31, 31],
          ],
    );
  });

  it.each([
    { position: [34, 31], target: [39, 29] },
    { position: [28, 31], target: [26, 29] },
    { position: [34, 35], target: [39, 40] },
  ] satisfies {
    position: Coordinate;
    target: Coordinate;
  }[])('keeps the entire footprint inside arena bounds and clipped corners from $position', ({ position, target }) => {
    const { move } = setup(position, target);
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
    const path = move();
    expect(path.length).toBeGreaterThan(0);
    for (const step of path) {
      for (const key of footprintKeys(step)) {
        const [x, y] = key.split(',').map(Number);
        expect(isInsideArena([x, y], SOL_ARENA), `${key} on ${step}`).toBe(true);
      }
    }
  });

  it('holds when no melee tile around the target can be reached', () => {
    const { move } = setup([34, 31], [41, 33]);
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
    expect(move()).toEqual([]);
  });

  it.each(['bound', 'dead Sol', 'dead target', 'removed target', 'removed Sol'] as const)('holds for %s', (reason) => {
    const { sol, player, world, move } = setup();
    switch (reason) {
      case 'bound':
        sol.debuffs = { boundFromTick: 20, boundUntilTick: 22 };
        break;
      case 'dead Sol':
        sol.alive = false;
        break;
      case 'dead target':
        player.alive = false;
        break;
      case 'removed target':
        world.actors.delete(player.id);
        break;
      case 'removed Sol':
        world.actors.delete(sol.id);
        break;
    }
    expect(move()).toEqual([]);
  });
});

describe('Sol actual movement lock application', () => {
  it.each([
    { name: 'spear', phase: 0, rolls: [0.1], release: 6 },
    { name: 'shield', phase: 0, rolls: [0.9], release: 4 },
    { name: 'grapple', phase: 2, rolls: [0.01, 0.01], release: 5 },
    // L:5581->5582, L:5628->5629: he chases on the tick after a triple's telegraph.
    { name: 'triple', phase: 1, rolls: [0.01], release: 1 },
  ] as const)('$name holds until warning+$release', ({ phase, rolls, release }) => {
    const { sol, player, context, move } = setup([31, 33], [32, 32]);
    sol.state.scheduler.forceSpearNext = false; // Exercise each style's lock outside the forced opener.
    const values: number[] = [...rolls];
    launchSolIfReady(sol, context, { phase, random: () => values.shift() ?? 0.5, enabled: true });
    player.position = [32, 30];
    expect(move(20 + release - 1)).toEqual([]);
    expect(move(20 + release)).toEqual([
      [31, 32],
      [31, 31],
    ]);
  });

  it('applies the same five-tick lock for the grapple command', () => {
    const { engine, sol, player, context, move } = setup([31, 33], [32, 32]);
    sol.state.immobileUntilTick = 0;
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'trigger-grapple' });
    launchSolIfReady(sol, context, { phase: 0, random: () => 0.5, enabled: false });
    expect(sol.state.grapple.pending?.startTick).toBe(20);
    player.position = [32, 30];
    expect(move(24)).toEqual([]);
    expect(move(25)).toEqual([
      [31, 32],
      [31, 31],
    ]);
  });

  it('suppresses movement immediately when a phase is pending', () => {
    const { sol, encounter, context } = setup();
    sol.vitals.hp = 1200;
    expect(encounter.moveNpc(sol, context, {})).toEqual([]);
  });

  it.each([0, 29])('applies phase+5 composed with existing deadline %s', (existing) => {
    const { sol, encounter, context, move } = setup();
    sol.vitals.hp = 1200;
    sol.state.immobileUntilTick = existing;
    runEncounterNpcActions(encounter, context, {
      solHereditAttacks: false,
      solHereditSand: false,
      solHereditBeams: false,
    });
    const release = Math.max(25, existing);
    expect(move(release - 1)).toEqual([]);
    expect(move(release)).toEqual([
      [31, 32],
      [31, 31],
    ]);
  });

  it('clears movement locks when a phase preset is entered', () => {
    const { sol, encounter, context, move } = setup();
    sol.state.immobileUntilTick = 100;
    encounter.enterBossHpPhase(1200, context);
    expect(move()).toEqual([
      [31, 32],
      [31, 31],
    ]);
  });
});

describe('Sol engine pursuit integration', () => {
  it('holds the spawn tile through control+5 and pursues from +6 while the player stays out of reach', () => {
    // M:8273..8278 holds with the player out of reach; N, whose player never approaches, moves at +6.
    const encounter = new SolHereditEncounter(7);
    const engine = new SimulationEngine({ encounter, combatRandom: () => 0.5 });
    const sol = engine['worldState'].getNpcs().find(solDefinition.isActor);
    if (!sol) throw new Error('Missing Sol');
    const positions = new Map<number, Coordinate>();
    while (engine.getState().currentTick < SOL_OPENING_HOLD_UNTIL_TICK) {
      engine.advanceTick([...SOL_PLAYER_START]);
      positions.set(engine.getState().currentTick, [...sol.position]);
    }
    for (let tick = 1; tick < SOL_OPENING_HOLD_UNTIL_TICK; tick++)
      expect(positions.get(tick)).toEqual(SOL_START_POSITION);
    // N 7308: a two-tile run south, the first move of a fight whose player never approached.
    expect(positions.get(SOL_OPENING_HOLD_UNTIL_TICK)).toEqual([31, 34]);
  });

  it('publishes both run steps without attacking on a ready arrival tick', () => {
    const { engine, sol } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, solHereditSand: false, solHereditBeams: false });
    sol.state.scheduler.nextAttackTick = 0;
    sol.state.immobileUntilTick = 0;
    engine.advanceTick([32, 30]);
    expect(sol.position).toEqual([31, 31]);
    expect(sol.previousPosition).toEqual([31, 33]);
    expect(sol.isRunning).toBe(true);
    expect(sol.state.scheduler.pendingGround).toBeNull();
    engine.advanceTick([32, 30]);
    expect(sol.isRunning).toBe(false);
    expect(sol.state.scheduler.pendingGround).not.toBeNull();
  });

  it('targets the pre-player tile on the K4042 one-step arrival', () => {
    const { engine, sol } = setup([31, 35], [32, 33]);
    engine.setMechanicsConfig({ solHereditAttacks: false, solHereditSand: false, solHereditBeams: false });
    sol.state.immobileUntilTick = 0;
    engine.advanceTick([32, 32]);
    expect(sol.position).toEqual([31, 34]);
    expect(sol.previousPosition).toEqual([31, 35]);
    expect(sol.isRunning).toBe(false);
    expect(engine.getState().playerPosition).toEqual([32, 32]);
  });
});
