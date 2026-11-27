import { afterEach, describe, expect, it, vi } from 'vitest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import { emitEncounterVisual } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import type { GameEvent } from '../../../core/events/types';
import { type ReplayDisplayFrame, ReplayRecorder } from '../../../core/ReplayRecorder';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { legacyNpc } from '../../../test/helpers/legacyEncounterRecordings';
import {
  activeWindows,
  IDENTITY_PROJECTION,
  installSyntheticSpotAnims,
  observeScene,
  replayContextAt,
  SCENE_OPTIONS,
  type SceneObservation,
  syntheticNpcAssets,
  VIEWPORT,
} from '../../../test/helpers/sceneObservation';
import type { Coordinate, SimulationState } from '../../../types/simulation';
import type { EncounterRenderConfig } from '../encounterRenderConfig';
import { createEncounterSceneBuilder } from '../encounterSceneBuilder';
import { SceneCompositor } from '../SceneCompositor';

/**
 * A new encounter on the common scene, with nothing of its own but its render config: one brute that
 * winds up a slam, throws a rock at the player and glows while it does. No scene subclass, no history
 * reader and no seek hook; the scene plays the batch live and restores it in replay.
 */
const BRUTE = { id: 'brute', npcTypeId: 9001, position: [20, 24] as Coordinate, size: 2 };
const IDLE_SEQ_ID = 9200;
const SLAM_SEQ_ID = 9201;
const ROCK_SPOT_ANIM_ID = 9101;
const GLOW_SPOT_ANIM_ID = 9102;
const PLAYER_TILE: Coordinate = [20, 20];
const LAST_TICK = 4;

const RENDER_CONFIG: EncounterRenderConfig = {
  preloadNpcTypes: [{ npcTypeId: BRUTE.npcTypeId, idleSeqId: IDLE_SEQ_ID, attackClips: { slam: SLAM_SEQ_ID } }],
  spotAnimIds: [ROCK_SPOT_ANIM_ID, GLOW_SPOT_ANIM_ID],
};

/** The encounter's producer: on tick 1 the brute attacks, as one batch emitted with the mechanic. */
function bruteTick(events: TickEvents, tick: number): void {
  if (tick !== 1) return;
  emitEncounterVisual(events, {
    animations: [{ actorId: BRUTE.id, clipId: 'slam', delayCycles: 6 }],
    projectiles: [
      {
        spotAnimId: ROCK_SPOT_ANIM_ID,
        sourcePosition: [BRUTE.position[0] + 1, BRUTE.position[1] + 1],
        target: { kind: 'actor', actorId: 'player', size: 1, position: PLAYER_TILE },
        startDelayCycles: 10,
        endDelayCycles: 40,
        slope: 16,
        startOffset: 64,
        startHeight: 80,
        endHeight: 40,
      },
    ],
    graphics: [
      { spotAnimId: GLOW_SPOT_ANIM_ID, target: { kind: 'attached', actorId: BRUTE.id }, delayCycles: 0, height: 64 },
    ],
  });
}

/** The run, recorded tick by tick through the recorder every run takes. */
function recordBruteRun(): readonly ReplayDisplayFrame[] {
  const engine = new SimulationEngine({ encounter: new LobbyEncounter(), combatSeed: 1 });
  const base = engine.getState();
  const recorder = new ReplayRecorder();
  recorder.startRun(engine.getRunConfig());
  const events = new TickEvents();
  for (let tick = 0; tick <= LAST_TICK; tick++) {
    events.setTick(tick);
    bruteTick(events, tick);
    const state: SimulationState = {
      ...base,
      currentTick: tick,
      playerPosition: [...PLAYER_TILE],
      playerPreviousPosition: [...PLAYER_TILE],
      playerMovementPath: [],
      npcs: [legacyNpc(BRUTE.id, BRUTE.npcTypeId, BRUTE.position, BRUTE.size)],
    };
    recorder.recordFrame(tick, state.playerPosition, state, events.flush());
  }
  return recorder.getDisplayFrames();
}

describe('a new encounter on the default scene builder', () => {
  const arena = getArenaConfig();
  const unbounded = getArenaAllowUnboundedFallback();
  const built: SceneCompositor[] = [];
  afterEach(() => {
    for (const scene of built.splice(0)) scene.dispose();
    vi.restoreAllMocks();
    setArenaConfig(arena, unbounded);
  });

  async function bruteScene(frames: readonly ReplayDisplayFrame[]) {
    // A kind with no core descriptor keeps its authored config.
    const scene = createEncounterSceneBuilder('brute', RENDER_CONFIG);
    if (!(scene instanceof SceneCompositor) || scene.constructor !== SceneCompositor)
      throw new Error('Expected the common scene');
    built.push(scene);
    const { loader, animation } = syntheticNpcAssets((id) => (id === BRUTE.npcTypeId ? BRUTE.size : 1));
    await scene.loadNpc(loader, animation);
    installSyntheticSpotAnims(scene, RENDER_CONFIG.spotAnimIds ?? []);
    const context = {
      speedMultiplier: 1,
      interaction: { hoveredTile: null, targetTile: null },
      options: SCENE_OPTIONS,
    };
    const build = (ctx: Parameters<SceneCompositor['build']>[0]) =>
      observeScene(scene, scene.build(ctx, IDENTITY_PROJECTION, VIEWPORT));
    return {
      live: (cycle: number) => {
        const frame = frames[Math.min(LAST_TICK, Math.floor(cycle / 30))];
        if (!frame) throw new RangeError(`No frame for cycle ${cycle}`);
        return build({ ...context, simulationState: frame.state, events: frame.events, interpolatedTick: cycle / 30 });
      },
      replay: (cycle: number, paused = false) => build({ ...context, ...replayContextAt(frames, cycle, paused) }),
    };
  }

  const idle = new Set([IDLE_SEQ_ID]);
  const keys = (observation: SceneObservation) => [
    ...observation.effects.map(({ spotAnimId }) => String(spotAnimId)),
    ...Object.entries(observation.poses)
      .filter(([, { seqId }]) => !idle.has(seqId))
      .map(([actorId, { seqId }]) => `${actorId}:${seqId}`),
  ];

  it('plays the clip, the flight and the attached graphic live, and replays them on the same cycles', async () => {
    const frames = recordBruteRun();
    const { live } = await bruteScene(frames);
    const played = activeWindows(live, 0, 120, idle);
    // The slam from its 6-cycle delay for the clip's 10 cycles; the rock from launch to its exclusive
    // landing; the glow on the brute for its 60 cycles.
    const windows = {
      effects: { [ROCK_SPOT_ANIM_ID]: [40, 69], [GLOW_SPOT_ANIM_ID]: [30, 89] },
      clips: { [`${BRUTE.id}:${SLAM_SEQ_ID}`]: [36, 45] },
    };
    expect(played).toEqual(windows);

    const { replay } = await bruteScene(frames);
    expect(activeWindows(replay, 0, 120, idle)).toEqual(windows);
    for (const [key, [first, last]] of Object.entries({ ...windows.effects, ...windows.clips })) {
      const sought = async (cycle: number) => keys((await bruteScene(frames)).replay(cycle, true));
      expect(await sought(first - 1), `${key} before ${first}`).not.toContain(key);
      expect(await sought(first), `${key} at ${first}`).toContain(key);
      expect(await sought(last), `${key} at ${last}`).toContain(key);
      expect(await sought(last + 1), `${key} after ${last}`).not.toContain(key);
    }
  });

  it('shows after a seek back and a seek forward exactly what a direct seek shows', async () => {
    const frames = recordBruteRun();
    const { replay } = await bruteScene(frames);
    for (let cycle = 0; cycle <= 80; cycle += 5) replay(cycle);
    const back = replay(42);
    const forward = replay(65);
    const direct = async (cycle: number) => (await bruteScene(frames)).replay(cycle);

    expect(back).toEqual(await direct(42));
    expect(forward).toEqual(await direct(65));
    // Each holds all three: the slam has ended by 65, the rock and the glow are still up.
    expect(keys(back).sort()).toEqual(
      [`${BRUTE.id}:${SLAM_SEQ_ID}`, String(ROCK_SPOT_ANIM_ID), String(GLOW_SPOT_ANIM_ID)].sort(),
    );
    expect(keys(forward).sort()).toEqual([String(ROCK_SPOT_ANIM_ID), String(GLOW_SPOT_ANIM_ID)].sort());
  });
});

// Keeps the producer's emitted shape honest: the batch is the only event the run records.
it('records the brute attack as one encounter_visual batch', () => {
  const events: GameEvent[] = recordBruteRun().flatMap((frame) => frame.events);
  expect(events.map(({ type, tick }) => [type, tick])).toEqual([['encounter_visual', 1]]);
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});
