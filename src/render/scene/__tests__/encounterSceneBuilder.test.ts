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
import type { RestoredPresentation } from '../../../types/restoredPresentation';
import type { Coordinate, NpcState, SimulationState } from '../../../types/simulation';
import type { EncounterRenderConfig } from '../encounterRenderConfig';
import { configureEncounterScene } from '../encounterSceneBuilder';
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

/** The brute's successor under its id: another NPC type, declaring a slam of its own. */
const SUCCESSOR = { npcTypeId: 9002, spawnTick: 2, idleSeqId: 9210, slamSeqId: 9202 };

const RENDER_CONFIG: EncounterRenderConfig = {
  preloadNpcTypes: [
    { npcTypeId: BRUTE.npcTypeId, idleSeqId: IDLE_SEQ_ID, attackClips: { slam: SLAM_SEQ_ID } },
    { npcTypeId: SUCCESSOR.npcTypeId, idleSeqId: SUCCESSOR.idleSeqId, attackClips: { slam: SUCCESSOR.slamSeqId } },
  ],
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

/** A run recorded tick by tick through the recorder every run takes; `tick` emits and names the NPCs. */
function recordRun(
  lastTick: number,
  tick: (events: TickEvents, tick: number) => readonly NpcState[],
): readonly ReplayDisplayFrame[] {
  const engine = new SimulationEngine({ encounter: new LobbyEncounter(), combatSeed: 1 });
  const base = engine.getState();
  const recorder = new ReplayRecorder();
  recorder.startRun(engine.getRunConfig());
  const events = new TickEvents();
  for (let current = 0; current <= lastTick; current++) {
    events.setTick(current);
    const npcs = tick(events, current);
    const state: SimulationState = {
      ...base,
      currentTick: current,
      playerPosition: [...PLAYER_TILE],
      playerPreviousPosition: [...PLAYER_TILE],
      playerMovementPath: [],
      npcs: [...npcs],
    };
    recorder.recordFrame(current, state.playerPosition, state, events.flush());
  }
  return recorder.getDisplayFrames();
}

function recordBruteRun(): readonly ReplayDisplayFrame[] {
  return recordRun(LAST_TICK, (events, tick) => {
    bruteTick(events, tick);
    return [legacyNpc(BRUTE.id, BRUTE.npcTypeId, BRUTE.position, BRUTE.size)];
  });
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
    // The common scene as the default builder configures it, with the brute's config.
    const scene = configureEncounterScene(new SceneCompositor(), { encounterRenderConfig: RENDER_CONFIG });
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
      scene,
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

  it('starts a batch shown on repeated live builds once, and again on a new timeline reusing its id', async () => {
    const frames = recordBruteRun();
    const { live, scene } = await bruteScene(frames);
    const updates = vi.spyOn(scene['npcInstanceManager'], 'updateAnimations');
    const slams = () =>
      updates.mock.calls.flatMap(([, , triggers]) => triggers).filter((trigger) => trigger.clipId === 'slam').length;
    // Every build of tick 1 hands the scene the tick's events again, the batch's among them.
    for (let cycle = 30; cycle <= 50; cycle++) live(cycle);
    expect(slams()).toBe(1);

    // A new timeline (a restart, a scene change) numbers its events afresh.
    scene.resetIntroState();
    const replayed = activeWindows(live, 30, 50, idle);
    expect(slams()).toBe(2);
    expect(replayed.clips).toEqual({ [`${BRUTE.id}:${SLAM_SEQ_ID}`]: [36, 45] });
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

describe("an actor's cues on a new life under its id", () => {
  const arena = getArenaConfig();
  const unbounded = getArenaAllowUnboundedFallback();
  afterEach(() => {
    vi.restoreAllMocks();
    setArenaConfig(arena, unbounded);
  });

  const REPLACED_LAST_TICK = 7;
  /**
   * How the brute's life ends at tick 1, and the successor that takes its id from tick 2 on: removed,
   * then a new spawn of another type that declares the same clip key; or, with no removal, a new spawn
   * of the same type in its place.
   */
  const ENDINGS = [
    { ending: 'despawned', successorTypeId: SUCCESSOR.npcTypeId, slamSeqId: SUCCESSOR.slamSeqId },
    { ending: 'respawned in place', successorTypeId: BRUTE.npcTypeId, slamSeqId: SLAM_SEQ_ID },
  ] as const;
  type Ending = (typeof ENDINGS)[number];

  /**
   * The brute schedules a slam and a glow on itself for cycle 100 and throws a rock that flies until
   * 200; its life ends before then, and its successor slams and glows on its own batch at tick 4.
   */
  function recordReplacedBrute({ ending, successorTypeId }: Ending): readonly ReplayDisplayFrame[] {
    return recordRun(REPLACED_LAST_TICK, (events, tick) => {
      const glow = {
        spotAnimId: GLOW_SPOT_ANIM_ID,
        target: { kind: 'attached', actorId: BRUTE.id },
        height: 64,
      } as const;
      if (tick === 0)
        emitEncounterVisual(events, {
          animations: [{ actorId: BRUTE.id, clipId: 'slam', delayCycles: 100 }],
          projectiles: [
            {
              spotAnimId: ROCK_SPOT_ANIM_ID,
              sourcePosition: [BRUTE.position[0] + 1, BRUTE.position[1] + 1],
              target: { kind: 'actor', actorId: 'player', size: 1, position: PLAYER_TILE },
              startDelayCycles: 0,
              endDelayCycles: 200,
              slope: 16,
              startOffset: 64,
              startHeight: 80,
              endHeight: 40,
            },
          ],
          graphics: [{ ...glow, delayCycles: 100 }],
        });
      if (tick === 4)
        emitEncounterVisual(events, {
          animations: [{ actorId: BRUTE.id, clipId: 'slam', delayCycles: 0 }],
          projectiles: [],
          graphics: [{ ...glow, delayCycles: 0 }],
        });
      const brute = legacyNpc(BRUTE.id, BRUTE.npcTypeId, BRUTE.position, BRUTE.size);
      if (tick === 0) return [brute];
      if (tick === 1) {
        if (ending === 'respawned in place') return [brute];
        events.emit({ type: 'actor_despawned', actorId: BRUTE.id });
        return [];
      }
      return [legacyNpc(BRUTE.id, successorTypeId, BRUTE.position, BRUTE.size, { spawnTick: SUCCESSOR.spawnTick })];
    });
  }

  const idle = new Set([IDLE_SEQ_ID, SUCCESSOR.idleSeqId]);
  /** Only the successor's own slam and glow, and the rock, which no life ends; from `from` on. */
  const windowsFor = ({ slamSeqId }: Ending, from = 0) => ({
    effects: { [ROCK_SPOT_ANIM_ID]: [from, 199], [GLOW_SPOT_ANIM_ID]: [120, 179] },
    clips: { [`${BRUTE.id}:${slamSeqId}`]: [120, 129] },
  });
  const shownAt = (ending: Ending, cycle: number) => {
    const { effects, clips } = windowsFor(ending);
    return Object.entries({ ...effects, ...clips })
      .filter(([, [first, last]]) => first <= cycle && cycle <= last)
      .map(([key]) => key)
      .sort();
  };
  const shown = (observation: SceneObservation) =>
    [
      ...new Set(observation.effects.map(({ spotAnimId }) => String(spotAnimId))),
      ...Object.entries(observation.poses)
        .filter(([, { seqId }]) => !idle.has(seqId))
        .map(([actorId, { seqId }]) => `${actorId}:${seqId}`),
    ].sort();

  async function scene(frames: readonly ReplayDisplayFrame[]) {
    const built = configureEncounterScene(new SceneCompositor(), { encounterRenderConfig: RENDER_CONFIG });
    const { loader, animation } = syntheticNpcAssets((id) =>
      id === SUCCESSOR.npcTypeId || id === BRUTE.npcTypeId ? BRUTE.size : 1,
    );
    await built.loadNpc(loader, animation);
    installSyntheticSpotAnims(built, RENDER_CONFIG.spotAnimIds ?? []);
    const context = {
      speedMultiplier: 1,
      interaction: { hoveredTile: null, targetTile: null },
      options: SCENE_OPTIONS,
    };
    const build = (ctx: Parameters<SceneCompositor['build']>[0]) =>
      observeScene(built, built.build(ctx, IDENTITY_PROJECTION, VIEWPORT));
    return {
      scene: built,
      live: (cycle: number) => {
        const frame = frames[Math.min(REPLACED_LAST_TICK, Math.floor(cycle / 30))];
        if (!frame) throw new RangeError(`No frame for cycle ${cycle}`);
        return build({ ...context, simulationState: frame.state, events: frame.events, interpolatedTick: cycle / 30 });
      },
      replay: (cycle: number) => build({ ...context, ...replayContextAt(frames, cycle, false) }),
      /**
       * Live play handed over by a restored presentation of the history through `tick`, which shows
       * the end of that tick; `live` then draws on from there.
       */
      restoreAt: (tick: number) => {
        const frame = frames[tick];
        if (!frame) throw new RangeError(`No frame for tick ${tick}`);
        const timeMs = (tick + 1) * 600;
        const restoration: RestoredPresentation = {
          engine: new SimulationEngine({ encounter: new LobbyEncounter(), combatSeed: 1 }),
          tick,
          timeMs,
          history: { frames: frames.slice(0, tick + 1), throughFrameIndex: tick },
        };
        const timeline = { timelineKey: 'restored', paused: false };
        const at = (cycle: number, paused: boolean) => {
          const shown = frames[Math.min(frames.length - 1, Math.floor(cycle / 30))];
          if (!shown) throw new RangeError(`No frame for cycle ${cycle}`);
          return build({
            ...context,
            simulationState: shown.state,
            events: shown.events,
            interpolatedTick: cycle / 30,
            restoredPresentation: restoration,
            timeline: { ...timeline, paused, timeMs: cycle * 20 },
          });
        };
        const restored = build({
          ...context,
          simulationState: frame.state,
          events: frame.events,
          interpolatedTick: tick + 1,
          restoredPresentation: restoration,
          frameDeltaMs: 0,
          timeline: { ...timeline, paused: true, timeMs },
        });
        return { restored, live: (cycle: number) => at(cycle, false) };
      },
    };
  }

  it.each(
    ENDINGS,
  )("never plays the old life's slam or glow on a successor once the brute is $ending: live, in replay, after a seek or a handoff", async (ending) => {
    const frames = recordReplacedBrute(ending);
    const opened: SceneCompositor[] = [];
    const open = async () => {
      const result = await scene(frames);
      opened.push(result.scene);
      return result;
    };
    try {
      expect(activeWindows((await open()).live, 0, 239, idle)).toEqual(windowsFor(ending));
      expect(activeWindows((await open()).replay, 0, 239, idle)).toEqual(windowsFor(ending));
      for (const cycle of [99, 100, 105, 119, 120, 125, 150])
        expect(shown((await open()).replay(cycle)), `seek to ${cycle}`).toEqual(shownAt(ending, cycle));

      // Restored at the end of tick 2, before the old life's slam and glow are due: live play takes
      // over what the history still owes, and none of it is the old life's.
      const handoff = (await open()).restoreAt(2);
      expect(shown(handoff.restored)).toEqual(shownAt(ending, 90));
      expect(activeWindows(handoff.live, 91, 239, idle)).toEqual(windowsFor(ending, 91));
    } finally {
      for (const built of opened) built.dispose();
    }
  });
});

// Keeps the producer's emitted shape honest: the batch is the only event the run records.
it('records the brute attack as one encounter_visual batch', () => {
  const events: GameEvent[] = recordBruteRun().flatMap((frame) => frame.events);
  expect(events.map(({ type, tick }) => [type, tick])).toEqual([['encounter_visual', 1]]);
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});
