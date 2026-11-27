import { afterEach, describe, expect, it, vi } from 'vitest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import type { ReplayDisplayFrame } from '../../../core/ReplayRecorder';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { YAMA_SPAWN_FIREBALL_COMMAND, YAMA_SPAWN_VOID_FLARE_COMMAND } from '../../../encounters/yamaP3/commands';
import { YAMA_ENCOUNTER_RENDER_CONFIG } from '../../../encounters/yamaP3/renderConfig';
import { YAMA_ATTACK_PRELOAD_IDS } from '../../../encounters/yamaP3/spotAnims';
import { YamaEncounter } from '../../../encounters/yamaP3/YamaEncounter';
import { YAMA_NPC_ID } from '../../../rs/model/NpcModelLoader';
import { legacyYamaRecording } from '../../../test/helpers/legacyEncounterRecordings';
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
import type { SimulationState } from '../../../types/simulation';
import { log } from '../../../util/Logger';
import type { Projection2D } from '../../core/camera';
import type { RenderQueue } from '../../core/commands';
import type { FightStartCountdownPhase, SceneObjectFrameContext } from '../../graphics/sceneObjectTypes';
import { PRIMARY_NPC_ACTOR_ID } from '../../npc/NpcInstanceManager';
import type { SceneCompositor } from '../SceneCompositor';
import type { SceneOptions } from '../types';
import { YamaSceneCompositor } from '../YamaSceneCompositor';

const projection: Projection2D = {
  tileToScreen: ({ x, y }) => ({ x: x * 10, y: y * 10 }),
  tileDeltaToScreen: (delta) => ({ x: delta.x * 10, y: delta.y * 10 }),
  screenToTile: () => null,
  tilePolygonScreen: ({ x, y }) => [
    { x: x * 10, y: y * 10 },
    { x: x * 10 + 10, y: y * 10 },
    { x: x * 10 + 10, y: y * 10 + 10 },
    { x: x * 10, y: y * 10 + 10 },
  ],
};

describe('YamaSceneCompositor practice spawns', () => {
  it('draws practice fireballs and void flares while both mechanic toggles are off', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 37] });
    engine.setMechanicsConfig({
      yamaMageRange: false,
      yamaMelee: false,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });
    engine.queueEncounterCommand(YAMA_SPAWN_FIREBALL_COMMAND);
    engine.queueEncounterCommand(YAMA_SPAWN_VOID_FLARE_COMMAND);
    // Commands land on tick 1: the flare activates on 4, the first fireball set falls from 3.
    for (let tick = 1; tick <= 4; tick++) engine.advanceTick([31, 37]);
    const state = engine.getState();
    const yama = new YamaSceneCompositor();
    yama['effectTick'] = state.currentTick;
    const queue: RenderQueue = { replayPresentationReady: true, commands: [] };

    yama['renderEncounterEffectsLate'](queue, projection, 4, 4, state, state.mechanicsConfig, true, {
      renderMode: '2d',
    } as SceneOptions);

    const fireballGlyphs = queue.commands.filter((command) => command.kind === 'circle2d');
    // Flare tiles and charge bar share the void flare's z layers (35/36).
    const flareCommands = queue.commands.filter(
      (command) => command.kind === 'poly2d' && (command.zIndex === 35 || command.zIndex === 36),
    );
    expect(fireballGlyphs.length).toBeGreaterThan(0);
    expect(flareCommands).toHaveLength(5);
    yama.dispose();
  });
});

describe('SceneCompositor scene objects', () => {
  it("hands each frame's fight-start countdown to the scene-object controller", () => {
    const update = vi.fn((_context: SceneObjectFrameContext<SimulationState>) => []);
    const yama = new YamaSceneCompositor();
    yama.setEncounterRenderConfig({ createSceneObjectController: () => ({ consumeEvents: () => {}, update }) });
    yama['setSceneObjectLocModelLoader']({ loadAnimatedLocMeshFrames: () => undefined });
    const state = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 37] }).getState();
    const draw = (fightStartCountdown?: FightStartCountdownPhase) =>
      yama.build(
        {
          simulationState: state,
          events: [],
          interpolatedTick: 0,
          speedMultiplier: 1,
          options: {
            renderMode: '3d',
            showCoordinates: false,
            showNpcClickbox: false,
            showTileMarkers: false,
            showTileMarkerLabels: false,
            showLineMarkers: false,
            showLineMarkerLabels: false,
            smoothTerrain: false,
            brightness: 1,
            contrast: 1,
            saturation: 1,
            encounterDebugFlags: {},
          },
          interaction: { hoveredTile: null, targetTile: null },
          ...(fightStartCountdown ? { fightStartCountdown } : {}),
        },
        projection,
        { width: 800, height: 600, dpr: 1 },
      );

    draw('holding');
    draw('released');
    draw();

    expect(update.mock.calls.map(([context]) => context.fightStartCountdown)).toEqual([
      'holding',
      'released',
      undefined,
    ]);
    yama.dispose();
  });
});

describe('SceneCompositor terrain loading', () => {
  it('makes a repeated request during a load wait for that load instead of returning early', async () => {
    const yama = new YamaSceneCompositor();
    let finish: (meshes: never[]) => void = () => {};
    const build = vi
      .spyOn(yama, 'buildTerrainMeshes3D')
      .mockImplementation(() => new Promise((resolve) => (finish = resolve as (meshes: never[]) => void)));
    const mapLoader = {} as Parameters<YamaSceneCompositor['loadTerrain']>[0];
    let secondSettled = false;

    const first = yama.loadTerrain(mapLoader);
    const second = yama.loadTerrain(mapLoader).then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    finish([{} as never]);
    await Promise.all([first, second]);
    expect(build).toHaveBeenCalledOnce();
    expect(yama.isTerrainLoaded()).toBe(true);
    yama.dispose();
  });

  it('fails every joined request when the load fails, and starts afresh on the next request', async () => {
    const yama = new YamaSceneCompositor();
    vi.spyOn(log, 'error').mockImplementation(() => {});
    const failure = new Error('map square unreadable');
    const build = vi
      .spyOn(yama, 'buildTerrainMeshes3D')
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([{} as never]);
    const mapLoader = {} as Parameters<YamaSceneCompositor['loadTerrain']>[0];

    const results = await Promise.allSettled([yama.loadTerrain(mapLoader), yama.loadTerrain(mapLoader)]);
    expect(results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(yama.isTerrainLoaded()).toBe(false);

    await yama.loadTerrain(mapLoader);
    expect(build).toHaveBeenCalledTimes(2);
    expect(yama.isTerrainLoaded()).toBe(true);
    yama.dispose();
  });

  it('publishes no terrain from a load that finishes after dispose', async () => {
    const yama = new YamaSceneCompositor();
    let finish: (meshes: never[]) => void = () => {};
    vi.spyOn(yama, 'buildTerrainMeshes3D').mockImplementation(
      () => new Promise((resolve) => (finish = resolve as (meshes: never[]) => void)),
    );
    const load = yama.loadTerrain({} as Parameters<YamaSceneCompositor['loadTerrain']>[0]);

    yama.dispose();
    finish([{} as never]);
    await load;

    expect(yama.isTerrainLoaded()).toBe(false);
  });
});

/**
 * Characterization of a recording of Yama's semantic events and snapshot (`legacyYamaRecording`).
 * Observed only through the render queue and NPC poses, so it pins what a player sees, not how the
 * scene produces it.
 */
describe('legacy Yama recording: continuous playback versus direct seek', () => {
  let recorded: readonly ReplayDisplayFrame[] | undefined;
  // Built inside the tests: constructing the engine sets the global arena, which `afterEach` resets.
  const legacyFrames = () => {
    recorded ??= legacyYamaRecording().frames;
    return recorded;
  };
  const idleSeqIds = new Set(YAMA_ENCOUNTER_RENDER_CONFIG.preloadNpcTypes?.flatMap(({ idleSeqId }) => idleSeqId ?? []));
  const built: SceneCompositor[] = [];
  const arena = getArenaConfig();
  const unbounded = getArenaAllowUnboundedFallback();
  afterEach(() => {
    for (const scene of built.splice(0)) scene.dispose();
    vi.restoreAllMocks();
    setArenaConfig(arena, unbounded);
  });

  async function legacyScene() {
    // The yama_p3 scene's compositor, with Yama's authored config: these frames load no terrain, so
    // the descriptor's map squares the resolved config adds would change nothing.
    const scene = new YamaSceneCompositor();
    scene.setEncounterRenderConfig(YAMA_ENCOUNTER_RENDER_CONFIG);
    built.push(scene);
    const { loader, animation } = syntheticNpcAssets((id) => (id === YAMA_NPC_ID ? 5 : 1));
    await scene.loadNpc(loader, animation);
    installSyntheticSpotAnims(scene, YAMA_ATTACK_PRELOAD_IDS);
    const context = {
      speedMultiplier: 1,
      interaction: { hoveredTile: null, targetTile: null },
      options: SCENE_OPTIONS,
    };
    return (cycle: number, paused = false) =>
      observeScene(
        scene,
        scene.build({ ...context, ...replayContextAt(legacyFrames(), cycle, paused) }, IDENTITY_PROJECTION, VIEWPORT),
      );
  }

  async function continuous(cycle: number, step = 5): Promise<SceneObservation> {
    const at = await legacyScene();
    for (let shown = 0; shown < cycle; shown += step) at(shown);
    return at(cycle);
  }

  const seek = async (cycle: number) => (await legacyScene())(cycle, true);
  const cued = ({ poses }: SceneObservation) =>
    Object.fromEntries(Object.entries(poses).filter(([, pose]) => !idleSeqIds.has(pose.seqId)));
  // The magic attack on tick 10: its impact on the player at once, its cast on Yama 30 cycles later.
  const impact = (frame: number) => ({ spotAnimId: 3247, frame, at: [33.5, 36.5, 0] });
  const cast = (frame: number) => ({ spotAnimId: 3246, frame, at: [31.5, 30.5, 0] });

  it.each([
    { cycle: 305, poses: {}, effects: [impact(0)] },
    { cycle: 335, poses: { [PRIMARY_NPC_ACTOR_ID]: { seqId: 12144, frame: 2 } }, effects: [cast(0), impact(1)] },
    { cycle: 345, poses: { [PRIMARY_NPC_ACTOR_ID]: { seqId: 12144, frame: 2 } }, effects: [cast(0), impact(2)] },
    // The melee attack on tick 13 plays the secondary clip at once.
    { cycle: 395, poses: { [PRIMARY_NPC_ACTOR_ID]: { seqId: 12146, frame: 2 } }, effects: [] },
  ])('shows the same attack at cycle $cycle whether played or sought', async ({ cycle, poses, effects }) => {
    for (const observation of [await continuous(cycle), await seek(cycle)]) {
      expect(cued(observation)).toEqual(poses);
      expect(observation.effects).toEqual(effects);
    }
  });

  it('starts and ends the attack effects and body clips on the same cycles whether played or sought', async () => {
    const at = await legacyScene();
    const played = activeWindows((cycle) => at(cycle), 0, 480, idleSeqIds);
    // A non-melee attack reserves the body now and plays it after its 30-cycle internal delay, for
    // three ticks; a melee attack plays its secondary clip at once.
    const clips = { [`${PRIMARY_NPC_ACTOR_ID}:12144`]: [330, 389], [`${PRIMARY_NPC_ACTOR_ID}:12146`]: [390, 399] };
    const effects = { 3247: [300, 359], 3246: [330, 389] };
    expect(played).toEqual({ effects, clips });
    const sought = async (cycle: number) => {
      const observation = await seek(cycle);
      return [
        ...observation.effects.map(({ spotAnimId }) => String(spotAnimId)),
        ...Object.entries(cued(observation)).map(([actorId, { seqId }]) => `${actorId}:${seqId}`),
      ];
    };
    for (const [key, [first, last]] of Object.entries({ ...effects, ...clips })) {
      expect(await sought(first - 1), `${key} before ${first}`).not.toContain(key);
      expect(await sought(first), `${key} at ${first}`).toContain(key);
      expect(await sought(last), `${key} at ${last}`).toContain(key);
      expect(await sought(last + 1), `${key} after ${last}`).not.toContain(key);
    }
  });
});

describe("Yama's body on the NPC clock", () => {
  const arena = getArenaConfig();
  const unbounded = getArenaAllowUnboundedFallback();
  const built: SceneCompositor[] = [];
  afterEach(() => {
    for (const scene of built.splice(0)) scene.dispose();
    vi.restoreAllMocks();
    setArenaConfig(arena, unbounded);
  });

  async function yamaScene() {
    const scene = new YamaSceneCompositor();
    scene.setEncounterRenderConfig(YAMA_ENCOUNTER_RENDER_CONFIG);
    built.push(scene);
    const { loader, animation } = syntheticNpcAssets((id) => (id === YAMA_NPC_ID ? 5 : 1));
    await scene.loadNpc(loader, animation);
    installSyntheticSpotAnims(scene, YAMA_ATTACK_PRELOAD_IDS);
    return scene;
  }

  // Live play takes each frame's snapshot as it arrives: the cast's reservation on tick 10 plays the
  // body 30 cycles later and the melee on tick 13 at once, on the displayed cycle whatever the wall
  // clock does between frames, exactly as the replay and its seeks show it.
  it('starts the live cast and melee bodies on the cycles replay shows them, whatever the frame time', async () => {
    const frames = legacyYamaRecording().frames;
    const scene = await yamaScene();
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const live = (cycle: number) => {
      const frame = frames[Math.min(frames.length - 1, Math.floor(cycle / 30))];
      if (!frame) throw new RangeError(`No frame for cycle ${cycle}`);
      // An uneven wall clock: long and short frames, none of them the displayed time.
      now.mockReturnValue(1000 + cycle * 37 + (cycle % 7) * 90);
      return observeScene(
        scene,
        scene.build(
          {
            speedMultiplier: 1,
            interaction: { hoveredTile: null, targetTile: null },
            options: SCENE_OPTIONS,
            simulationState: frame.state,
            events: frame.events,
            interpolatedTick: cycle / 30,
          },
          IDENTITY_PROJECTION,
          VIEWPORT,
        ),
      );
    };
    const idleSeqIds = new Set(
      YAMA_ENCOUNTER_RENDER_CONFIG.preloadNpcTypes?.flatMap(({ idleSeqId }) => idleSeqId ?? []),
    );

    expect(activeWindows(live, 0, 480, idleSeqIds).clips).toEqual({
      [`${PRIMARY_NPC_ACTOR_ID}:12144`]: [330, 389],
      [`${PRIMARY_NPC_ACTOR_ID}:12146`]: [390, 399],
    });
  });
});
