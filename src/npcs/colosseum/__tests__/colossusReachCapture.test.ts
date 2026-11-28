import { afterEach, expect, it } from 'vitest';
import type { NpcActor } from '../../../core/actors/NpcActor';
import type { PlayerActor } from '../../../core/actors/PlayerActor';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import type { GameEvent } from '../../../core/events/types';
import {
  canNpcActThisTurn,
  isNpcDeathDue,
  promoteHitQueueDeath,
  recordNpcLethalTransition,
  recordNpcStep,
  startNpcDeath,
} from '../../../core/npcDeath';
import type { NpcDefinitionContext, NpcDefinitionRegistration } from '../../../core/npcs';
import { SimulationEngine } from '../../../core/SimulationEngine';
import type { WorldState } from '../../../core/WorldState';
import { SolHereditEncounter } from '../../../encounters/solHeredit/SolHereditEncounter';
import { findProjectCacheZip, loadColosseumWaveArena } from '../../../test/helpers/colosseumCollision';
import { REAL_CACHE_TEST_TIMEOUT_MS, skipWithoutRealCache } from '../../../test/helpers/real-cache';
import type { Coordinate } from '../../../types/simulation';
import { moveColossus } from '../colossusReach';
import {
  createJavelinColossus,
  JAVELIN_COLOSSUS_SPOTANIMS,
  JAVELIN_DEATH_TO_REMOVAL_TICKS,
  javelinColossusDefinition,
  landJavelinArtillery,
} from '../javelinColossus';
import {
  createShockwaveColossus,
  SHOCKWAVE_DEATH_TO_REMOVAL_TICKS,
  shockwaveColossusDefinition,
} from '../shockwaveColossus';
import {
  COLOSSUS_CAPTURE_INSTANCES,
  COLOSSUS_CAPTURE_PLAYER,
  type ColossusAttackKind,
  type ColossusCapture,
  type ColossusCaptureInstance,
  JAVELIN_CAPTURE_ARTILLERY,
  SHOCKWAVE_CAPTURE_CASTS,
} from './fixtures/colossusReachCapture';

/**
 * Replays every captured Javelin and Shockwave Colossus through the production definitions: the observed
 * post-move tile and the player's start-of-tick tile each tick, the cache's pillar collision (local origin
 * 1792/3072), and the captured kill. Each tick's launches, artillery cues and flight times must match.
 */
const originalArena = getArenaConfig();
const originalUnbounded = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(originalArena, originalUnbounded));

const JAVELIN = javelinColossusDefinition.register(undefined);
const SHOCKWAVE = shockwaveColossusDefinition.register(undefined);

/** The value of a `[tick, x, y]` change list at `tick`. */
function tileAt(
  changes: readonly (readonly [number, number, number])[],
  tick: number,
  initial?: Coordinate,
): Coordinate {
  let tile = initial;
  for (const [at, x, y] of changes) {
    if (at > tick) break;
    tile = [x, y];
  }
  if (!tile) throw new Error(`No tile at ${tick}`);
  return tile;
}

interface Launch {
  readonly tick: number;
  readonly kind: ColossusAttackKind;
  readonly impactDelayTicks?: number;
  readonly endDelayCycles?: number;
}

interface Replay {
  readonly launches: Launch[];
  /** Ground cues as `[emit tick, delay, spotanim, tile]`. */
  readonly ground: [number, number, number, Coordinate][];
  deathAnimationTick: number | undefined;
  readonly spawnStep: { readonly moved: Coordinate; readonly expected: Coordinate };
  /** Ticks it was ready, alive and out of reach: what line of sight and range held back. */
  heldTicks: number;
}

function replay(instance: ColossusCaptureInstance, world: WorldState, player: PlayerActor): Replay {
  const isJavelin = instance.npcId === 12817;
  const input = { id: `colossus-${instance.index}`, position: instance.spawn, spawnTick: instance.addTick };
  const actor: NpcActor = isJavelin ? createJavelinColossus(input) : createShockwaveColossus(input);
  const registration: NpcDefinitionRegistration = isJavelin ? JAVELIN : SHOCKWAVE;
  world.actors.set(actor.id, actor);
  const playerTrack = COLOSSUS_CAPTURE_PLAYER[instance.capture];
  const result: Replay = {
    launches: [],
    ground: [],
    deathAnimationTick: undefined,
    spawnStep: { moved: [...instance.spawn], expected: tileAt(instance.track, instance.addTick + 1, instance.spawn) },
    heldTicks: 0,
  };
  const collectGround = (events: readonly GameEvent[], tick: number) => {
    for (const visual of events.filter(isEncounterVisualEvent)) {
      for (const graphic of visual.graphics) {
        if (graphic.target.kind === 'tile')
          result.ground.push([tick, graphic.delayCycles, graphic.spotAnimId, graphic.target.position]);
      }
    }
  };
  try {
    for (let tick = instance.addTick + 1; tick <= instance.lastTick; tick++) {
      const context: NpcDefinitionContext = {
        tick,
        world,
        tickEvents: new TickEvents(),
        random: () => 0.5,
        spawnNpc: () => undefined,
        despawnNpc: () => undefined,
        logEvent: () => undefined,
      };
      player.position = tileAt(playerTrack, tick);
      // The wave owner's `resolveHazards`, before the NPC band.
      if (javelinColossusDefinition.isActor(actor)) landJavelinArtillery(actor, context);
      collectGround(context.tickEvents.flush(), tick);
      // The kill lands in its hit pass, before its turn; the capture's death-sequence tick says whether
      // another hit followed the lethal one (death processed at once) or not (a tick later).
      if (tick === instance.killTick) {
        recordNpcLethalTransition(actor, tick, 'hit-queue');
        if (instance.deathSeqTick === tick) promoteHitQueueDeath(actor, tick);
      }
      if (isNpcDeathDue(actor, tick)) {
        startNpcDeath(actor);
        registration.notifyDeathStarted(actor, context);
        result.deathAnimationTick = actor.deathAnimationTick;
      }
      if (!canNpcActThisTurn(actor, tick)) continue;
      if (tick === instance.addTick + 1) {
        const step = moveColossus(actor, context)[0]?.path[0];
        if (step) result.spawnStep.moved.splice(0, 2, ...step);
      }
      actor.previousPosition = actor.position;
      actor.position = tileAt(instance.track, tick, instance.spawn);
      if (actor.position[0] !== actor.previousPosition[0] || actor.position[1] !== actor.previousPosition[1]) {
        recordNpcStep(actor, tick);
      }
      const ready = actor.combat.nextActionTick <= tick && actor.alive;
      const { npcAttacks } = registration.tick(actor, context);
      const events = context.tickEvents.flush();
      const [visual] = events.filter(isEncounterVisualEvent);
      const clip = visual?.animations.find((animation) => animation.actorId === actor.id)?.clipId;
      if (clip === 'artillery') result.launches.push({ tick, kind: 'A' });
      else if (clip === 'attack') {
        const [attack] = npcAttacks ?? [];
        result.launches.push({
          tick,
          kind: isJavelin ? 'R' : 'S',
          impactDelayTicks: attack?.impactDelayTicks,
          endDelayCycles: visual?.projectiles[0]?.endDelayCycles,
        });
      } else if (ready) result.heldTicks++;
      collectGround(events, tick);
    }
  } finally {
    world.actors.delete(actor.id);
  }
  return result;
}

it.skipIf(skipWithoutRealCache())(
  'replays every captured colossus launch, artillery cue and death through the production definitions',
  async () => {
    // The engine installs its own arena; the cache's wave arena replaces it.
    const world = new SimulationEngine({ encounter: new SolHereditEncounter(1) })['worldState'];
    setArenaConfig(await loadColosseumWaveArena(findProjectCacheZip()!));
    const player = world.getPlayer()!;
    world.actors.clear();
    world.occupancy.clear();
    world.actors.set(player.id, player);

    const artilleryByCast = new Map(
      JAVELIN_CAPTURE_ARTILLERY.map(([capture, tick, tile, blast]) => [`${capture}:${tick}`, { tile, blast }]),
    );
    const shockwaveEnds = new Map(SHOCKWAVE_CAPTURE_CASTS.map(([capture, tick, end]) => [`${capture}:${tick}`, end]));
    const totals = { R: 0, A: 0, S: 0, held: 0, artilleryChecked: 0, castsChecked: 0 };

    for (const instance of COLOSSUS_CAPTURE_INSTANCES) {
      const label = `${instance.capture} index ${instance.index}`;
      const run = replay(instance, world, player);
      const at = (capture: ColossusCapture, tick: number) => `${capture}:${tick}`;

      expect(run.spawnStep.moved, `${label} spawn step`).toEqual(run.spawnStep.expected);
      expect(
        run.launches.map(({ tick, kind }) => [tick, kind]),
        label,
      ).toEqual(instance.attacks.map(([tick, kind]) => [tick, kind]));
      totals.held += run.heldTicks;

      for (const launch of run.launches) {
        totals[launch.kind]++;
        if (launch.kind === 'R') expect(launch.impactDelayTicks, `${label} ${launch.tick}`).toBe(3);
        if (launch.kind === 'S') {
          const end = shockwaveEnds.get(at(instance.capture, launch.tick));
          expect(launch.endDelayCycles, `${label} ${launch.tick} endtime`).toBe(end);
          expect(launch.impactDelayTicks, `${label} ${launch.tick} hit`).toBe(Math.floor(end! / 30));
          totals.castsChecked++;
        }
        if (launch.kind !== 'A') continue;
        const captured = artilleryByCast.get(at(instance.capture, launch.tick))!;
        const warning = run.ground.filter(
          ([tick, , spotAnimId]) =>
            tick === launch.tick + 2 && spotAnimId === JAVELIN_COLOSSUS_SPOTANIMS.artilleryShadow,
        );
        const blast = run.ground.filter(
          ([tick, , spotAnimId]) =>
            tick === launch.tick + 6 && spotAnimId === JAVELIN_COLOSSUS_SPOTANIMS.artilleryBlast,
        );
        // Emitted from T+2 with delay 60: the capture's T+3 map_anim with delay 30.
        expect(
          warning.map(([tick, delay, , tile]) => [tick * 30 + delay, tile]),
          `${label} artillery ${launch.tick}`,
        ).toEqual(captured.tile ? [[(launch.tick + 3) * 30 + 30, captured.tile]] : []);
        expect(
          blast.map(([, , , tile]) => tile),
          `${label} blast ${launch.tick}`,
        ).toEqual(captured.blast ? [captured.tile] : []);
        totals.artilleryChecked++;
      }

      if (instance.deathSeqTick !== null) {
        expect(run.deathAnimationTick, `${label} death sequence`).toBe(instance.deathSeqTick);
        const removalDelay =
          instance.npcId === 12817 ? JAVELIN_DEATH_TO_REMOVAL_TICKS : SHOCKWAVE_DEATH_TO_REMOVAL_TICKS;
        expect(instance.removalTick! - instance.deathSeqTick, `${label} removal`).toBe(removalDelay);
      }
    }

    // Every captured attack but B:3404's cast, after the player's death, and thousands of ready ticks the
    // gate held back for line of sight or range.
    expect(SHOCKWAVE_CAPTURE_CASTS).toHaveLength(63);
    expect(totals).toMatchObject({ R: 370, A: 74, S: 62, artilleryChecked: 74, castsChecked: 62 });
    expect(totals.held).toBeGreaterThan(3000);
  },
  REAL_CACHE_TEST_TIMEOUT_MS,
);
