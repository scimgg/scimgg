import { afterEach, describe, expect, it } from 'vitest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import type { NpcAttackRequest } from '../../../core/encounters/types';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import {
  isNpcKillTurnReleaseDue,
  promoteHitQueueDeath,
  recordNpcLethalTransition,
  startNpcDeath,
} from '../../../core/npcDeath';
import type { NpcDefinitionContext } from '../../../core/npcs';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { CollisionFlag } from '../../../rs/collision/CollisionFlag';
import { createCollisionMap } from '../../../rs/collision/WalkabilityAnalyzer';
import { findProjectCacheZip, loadColosseumWaveArena } from '../../../test/helpers/colosseumCollision';
import { REAL_CACHE_TEST_TIMEOUT_MS, skipWithoutRealCache } from '../../../test/helpers/real-cache';
import type { Coordinate } from '../../../types/simulation';
import {
  createManticore,
  MANTICORE_DEATH_TO_REMOVAL_TICKS,
  MANTICORE_ORB_SPOTANIMS,
  type ManticoreActor,
  type ManticoreFirstStyle,
  type ManticoreOrbStyle,
  manticoreDefinition,
  manticoreHeldOrbs,
  releaseManticoreKillTurn,
} from '../manticore';
import {
  type CapturedOrbStyle,
  MANTICORE_CAPTURE_GROUPS,
  type ManticoreCaptureGroup,
  type ManticoreCaptureMember,
} from './fixtures/manticoreCapture';

/**
 * Replays every captured Manticore tick through the production definition: the player's start-of-tick tile
 * and each Manticore's post-move tile come from the capture, and the definition decides every spot, charge,
 * throw and orb. Instances of one wave share a world, ticked in spawn (NPC index) order.
 */
const registration = manticoreDefinition.register(undefined);
const STYLE_BY_SPOTANIM = new Map(
  (Object.entries(MANTICORE_ORB_SPOTANIMS) as [ManticoreOrbStyle, number][]).map(([style, id]) => [id, style]),
);

const originalArena = getArenaConfig();
const originalUnbounded = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(originalArena, originalUnbounded));

/** The four 3x3 pillars (cache LOC 52490, SW corners as in ColosseumAssets.test.ts) and nothing else. */
function pillarsOnlyArena() {
  const map = createCollisionMap(64, 64);
  for (const [x0, y0] of [
    [24, 26],
    [24, 41],
    [39, 26],
    [39, 41],
  ] as const) {
    for (let dx = 0; dx < 3; dx++)
      for (let dy = 0; dy < 3; dy++)
        map.flag(x0 + dx, y0 + dy, CollisionFlag.OBJECT | CollisionFlag.OBJECT_PROJECTILE_BLOCKER);
  }
  return { bounds: null, walkableTiles: null, collisionMap: map };
}

interface Observed {
  charges: number[];
  throws: number[];
  orbs: [number, CapturedOrbStyle, Coordinate][];
  attacks: [number, string][];
  /** `manticoreHeldOrbs` after each turn, as change points like the fixture's. */
  heldOrbs: [number, [number, number][]][];
}

function firstStyleOf(member: ManticoreCaptureMember): ManticoreFirstStyle {
  const first = member.orbs[0]?.[1];
  if (first !== 'ranged' && first !== 'magic') throw new TypeError(`Instance ${member.index} has no first orb`);
  return first;
}

/** Its death-sequence tick, the last on which it may release anything (A:4177 launched an orb on it). */
const lastTurn = (member: ManticoreCaptureMember) => member.deathSequenceTick ?? member.removalTick ?? Infinity;

/**
 * The death-sequence tick as the engine's promoted queued death: killed in its hit pass with its death processed
 * at once, so it takes no ordinary turn and releases only what was due on that kill turn
 * (`releaseManticoreKillTurn`), whenever its death animation then starts.
 */
function dieOnDeathSequenceTick(actor: ManticoreActor, context: NpcDefinitionContext): NpcAttackRequest[] {
  recordNpcLethalTransition(actor, context.tick, 'hit-queue');
  promoteHitQueueDeath(actor, context.tick);
  startNpcDeath(actor);
  if (!isNpcKillTurnReleaseDue(actor, context.tick)) throw new Error(`${actor.id} has no kill-turn release due`);
  return [...releaseManticoreKillTurn(actor, context)];
}

type Arena = Parameters<typeof setArenaConfig>[0];

function replayGroup(group: ManticoreCaptureGroup, arena: Arena): Observed[] {
  const world = new SimulationEngine({ encounter: new LobbyEncounter() })['worldState'];
  // After the engine, which installs its encounter's arena.
  setArenaConfig(arena);
  const player = world.getPlayer()!;
  world.actors.clear();
  world.actors.set(player.id, player);
  const members = [...group.members].sort((a, b) => a.index - b.index);
  const order = members.map((member) => group.members.indexOf(member));
  const actors: (ManticoreActor | null)[] = members.map(() => null);
  const observed: Observed[] = members.map(() => ({ charges: [], throws: [], orbs: [], attacks: [], heldOrbs: [] }));
  const firstTick = Math.min(...members.map((member) => member.addTick));
  let row = 0;
  for (let tick = firstTick; tick <= group.endTick; tick++) {
    while (row + 1 < group.track.length && group.track[row + 1]![0] <= tick) row++;
    const [, playerStart, ...tiles] = group.track[row]!;
    player.position = [...playerStart];
    const tickEvents = new TickEvents();
    const context: NpcDefinitionContext = {
      tick,
      world,
      tickEvents,
      random: () => 0.5,
      spawnNpc: () => undefined,
      despawnNpc: () => undefined,
      logEvent: () => undefined,
    };
    members.forEach((member, slot) => {
      if (tick === member.addTick) {
        const actor = createManticore({
          id: `manticore_${member.index}`,
          position: member.addTile,
          spawnTick: member.addTick,
          firstStyle: firstStyleOf(member),
        });
        actors[slot] = actor;
        world.actors.set(actor.id, actor);
      }
      const actor = actors[slot];
      const tile = tiles[order[slot]!];
      if (!actor || !tile || tick > lastTurn(member)) return;
      actor.previousPosition = actor.position;
      actor.position = [...tile];
      const attacks =
        tick === member.deathSequenceTick
          ? dieOnDeathSequenceTick(actor, context)
          : (registration.tick(actor, context).npcAttacks ?? []);
      for (const attack of attacks) observed[slot]!.attacks.push([tick, attack.style]);
      const held = manticoreHeldOrbs(actor, tick).map((orb): [number, number] => [orb.spotAnimId, orb.height]);
      const changes = observed[slot]!.heldOrbs;
      if (JSON.stringify(changes.at(-1)?.[1]) !== JSON.stringify(held)) changes.push([tick, held]);
    });
    for (const event of tickEvents.flush()) {
      if (!isEncounterVisualEvent(event)) continue;
      for (const animation of event.animations) {
        const slot = actors.findIndex((actor) => actor?.id === animation.actorId);
        if (animation.clipId === 'charge') observed[slot]!.charges.push(tick);
        if (animation.clipId === 'throw') observed[slot]!.throws.push(tick);
      }
      for (const projectile of event.projectiles) {
        const slot = actors.findIndex(
          (actor) =>
            actor !== null &&
            [actor.position, actor.previousPosition].some(
              ([x, y]) => projectile.sourcePosition[0] === x + 1.5 && projectile.sourcePosition[1] === y + 1.5,
            ),
        );
        observed[slot]!.orbs.push([
          tick,
          STYLE_BY_SPOTANIM.get(projectile.spotAnimId)!,
          [Math.floor(projectile.sourcePosition[0]), Math.floor(projectile.sourcePosition[1])],
        ]);
      }
    }
  }
  return group.members.map((member) => observed[members.indexOf(member)]!);
}

const label = (group: ManticoreCaptureGroup) =>
  `${group.capture} ${group.members.map((member) => `${member.index}@${member.addTick}`).join('+')}`;

function expectCaptureReplay(arena: Arena): void {
  for (const group of MANTICORE_CAPTURE_GROUPS) {
    const replayed = replayGroup(group, arena);
    group.members.forEach((member, slot) => {
      const observed = replayed[slot]!;
      const capturedCharges = member.charges.filter((tick) => tick <= lastTurn(member));
      expect({ instance: `${label(group)} #${member.index}`, charges: observed.charges }).toEqual({
        instance: `${label(group)} #${member.index}`,
        charges: capturedCharges,
      });
      expect(observed.throws, `${label(group)} #${member.index} throws`).toEqual(member.throws);
      expect(observed.orbs, `${label(group)} #${member.index} orbs`).toEqual(member.orbs);
      expect(observed.heldOrbs, `${label(group)} #${member.index} held orbs`).toEqual(member.heldOrbs);
      expect(observed.attacks, `${label(group)} #${member.index} attacks`).toEqual(
        member.orbs.map(([tick, style]) => [tick, style === 'ranged' ? 'range' : style]),
      );
    });
  }
}

describe('Manticore capture conformance', () => {
  it('reproduces every captured charge, throw, orb and held orb with the pillars as the only obstruction', () => {
    expectCaptureReplay(pillarsOnlyArena());
  });

  const cachePath = findProjectCacheZip();
  it.skipIf(skipWithoutRealCache())(
    'reproduces every captured charge, throw, orb and held orb in the cache arena',
    async () => {
      expectCaptureReplay(await loadColosseumWaveArena(cachePath!));
    },
    REAL_CACHE_TEST_TIMEOUT_MS,
  );

  it('covers a pair tie, a long hold, a one-tick spot and a death mid-throw', () => {
    const member = (index: number) =>
      MANTICORE_CAPTURE_GROUPS.flatMap((group) => group.members).find((candidate) => candidate.index === index)!;
    // A:3422: both charge together; the lower index throws at 3428 and the other waits to 3433.
    expect([member(63702).throws[0], member(63703).throws[0]]).toEqual([3428, 3433]);
    expect(member(63702).charges[0]).toBe(member(63703).charges[0]);
    // A:2660 -> 2863: held behind the pillar for 203 ticks; the orbs appear A:2661-2663 and stay until the throw.
    expect(member(52673).throws[0]! - member(52673).charges[0]!).toBe(203);
    expect(
      member(52673)
        .heldOrbs.slice(1, 5)
        .map(([tick, orbs]) => [tick, orbs.length]),
    ).toEqual([
      [2661, 1],
      [2662, 2],
      [2663, 3],
      [2863, 2],
    ]);
    // A:4177: the second orb on the death-sequence tick, never the third.
    expect(
      member(37314)
        .orbs.slice(-2)
        .map(([tick]) => tick),
    ).toEqual([4176, 4177]);
    expect(member(37314).deathSequenceTick).toBe(4177);
  });

  it('removes each corpse MANTICORE_DEATH_TO_REMOVAL_TICKS after its death sequence', () => {
    for (const member of MANTICORE_CAPTURE_GROUPS.flatMap((group) => group.members)) {
      expect(member.removalTick! - member.deathSequenceTick!, `#${member.index}`).toBe(
        MANTICORE_DEATH_TO_REMOVAL_TICKS,
      );
    }
  });
});
