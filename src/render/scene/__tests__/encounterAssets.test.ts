import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, EventAudioPlayer, FrameSoundTracker } from '../../../audio';
import type { CacheManager } from '../../../cache/CacheManager';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import type { ReplayDisplayFrame } from '../../../core/ReplayRecorder';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import {
  IDENTITY_PROJECTION,
  installSyntheticSpotAnims,
  replayContextAt,
  SCENE_OPTIONS,
  syntheticNpcAssets,
  VIEWPORT,
} from '../../../test/helpers/sceneObservation';
import { OSRS_TICK_MS } from '../../../types/simulation';
import type { EncounterRenderConfig } from '../encounterRenderConfig';
import { configureEncounterScene } from '../encounterSceneBuilder';
import { SceneCompositor } from '../SceneCompositor';
import { SceneBuilderRegistry, sceneBuilderFactoryFor } from '../sceneBuilderFactory';
import type { RenderContext } from '../types';

/**
 * The base compositor owns an encounter's asset loading and readiness from its render config alone:
 * which NPC types load and with what, when a replay frame may be presented, and the common scene an
 * encounter gets without a scene builder of its own.
 */

const BOSS = 9001;
const MINION = 9002;
const HAZARD = 9003;
const EFFECT = 9100;

const MINION_ENTRY = { npcTypeId: MINION, idleSeqId: 7101, attackClips: { attack: 7102 } };
const HAZARD_ENTRY = { npcTypeId: HAZARD, idleSeqId: 7201 };

/** No primary NPC, as the Inferno has none. */
const PRIMARYLESS: EncounterRenderConfig = { preloadNpcTypes: [MINION_ENTRY, HAZARD_ENTRY] };

/** A primary NPC whose own preload entry adds its idle and attack clips. */
const WITH_PRIMARY: EncounterRenderConfig = {
  primaryNpc: {
    actorId: 'boss',
    npcTypeId: BOSS,
    basePosition: [10, 10],
    size: 1,
    deathSeqId: 7001,
    deathRetentionTicks: 4,
  },
  preloadNpcTypes: [MINION_ENTRY, { npcTypeId: BOSS, idleSeqId: 7002, attackClips: { attack: 7003 } }, HAZARD_ENTRY],
  spotAnimIds: [EFFECT],
};

const scenes: SceneCompositor[] = [];
const arena = getArenaConfig();
const unbounded = getArenaAllowUnboundedFallback();
afterEach(() => {
  for (const scene of scenes.splice(0)) scene.dispose();
  vi.restoreAllMocks();
  setArenaConfig(arena, unbounded);
});

function sceneWith(config: EncounterRenderConfig): SceneCompositor {
  const scene = new SceneCompositor();
  scene.setEncounterRenderConfig(config);
  scenes.push(scene);
  return scene;
}

/** Builds one replay frame of a lobby state in `renderMode`. */
function drawReplay(scene: SceneCompositor, renderMode: '2d' | '3d', paused = false) {
  const frames: ReplayDisplayFrame[] = [
    { state: new SimulationEngine({ encounter: new LobbyEncounter() }).getState(), events: [] },
  ];
  const context: RenderContext = {
    speedMultiplier: 1,
    interaction: { hoveredTile: null, targetTile: null },
    options: { ...SCENE_OPTIONS, renderMode },
    ...replayContextAt(frames, 0, paused),
  };
  return scene.build(context, IDENTITY_PROJECTION, VIEWPORT);
}

const assetState = (scene: SceneCompositor) => scene['encounterAssetState']();

describe('encounter NPC loading from the render config', () => {
  it('loads every declared type once for an encounter without a primary NPC, and still hands over animation', async () => {
    const scene = sceneWith(PRIMARYLESS);
    const load = vi.spyOn(scene, 'loadNpcType');
    const { loader, animation } = syntheticNpcAssets();

    await scene.loadNpc(loader, animation);
    await scene.loadNpc(loader, animation);

    expect(load.mock.calls).toEqual([
      [MINION, loader, animation, MINION_ENTRY],
      [HAZARD, loader, animation, HAZARD_ENTRY],
    ]);
    expect(scene.isNpcLoaded()).toBe(true);
    expect(scene['playerAnimationSystem']).toBe(animation);
    expect(assetState(scene)).toBe('ready');
  });

  it("loads the primary once, with its preload entry's clips and its death settings, and the rest as declared", async () => {
    const scene = sceneWith(WITH_PRIMARY);
    installSyntheticSpotAnims(scene, [EFFECT]);
    const load = vi.spyOn(scene, 'loadNpcType');
    const { loader, animation } = syntheticNpcAssets();

    await scene.loadNpc(loader, animation);

    expect(load.mock.calls).toEqual([
      [
        BOSS,
        loader,
        animation,
        {
          npcTypeId: BOSS,
          idleSeqId: 7002,
          attackClips: { attack: 7003 },
          deathSeqId: 7001,
          bossDeathAnimationEnabled: true,
          deathDurationMs: 4 * OSRS_TICK_MS,
        },
      ],
      [MINION, loader, animation, MINION_ENTRY],
      [HAZARD, loader, animation, HAZARD_ENTRY],
    ]);
    expect([BOSS, MINION, HAZARD].map((id) => scene.isNpcTypeLoaded(id))).toEqual([true, true, true]);
    expect(assetState(scene)).toBe('ready');
  });

  it('settles a type that fails to load without failing the scene; only the primary failing rejects', async () => {
    const { loader, animation } = syntheticNpcAssets();
    const failing = (npcTypeId: number) => (scene: SceneCompositor) => {
      const manager = scene['npcInstanceManager'];
      const real = manager.loadNpcType.bind(manager);
      vi.spyOn(manager, 'loadNpcType').mockImplementation((id, ...rest) =>
        id === npcTypeId ? Promise.reject(new Error(`model ${id} missing`)) : real(id, ...rest),
      );
      return scene;
    };

    const minionMissing = failing(MINION)(sceneWith(WITH_PRIMARY));
    installSyntheticSpotAnims(minionMissing, [EFFECT]);
    await expect(minionMissing.loadNpc(loader, animation)).resolves.toBeUndefined();
    expect(minionMissing.isNpcLoaded()).toBe(true);
    expect(minionMissing.isNpcTypeLoaded(HAZARD)).toBe(true);
    expect(assetState(minionMissing)).toBe('unavailable');

    const bossMissing = failing(BOSS)(sceneWith(WITH_PRIMARY));
    await expect(bossMissing.loadNpc(loader, animation)).rejects.toThrow(`model ${BOSS} missing`);
    expect(bossMissing.isNpcLoaded()).toBe(false);
    expect(bossMissing.isNpcTypeLoaded(MINION)).toBe(true);
  });

  it('tries a type that failed in one scene again in the next scene for the encounter', async () => {
    const { loader, animation } = syntheticNpcAssets();
    const failed = sceneWith(WITH_PRIMARY);
    installSyntheticSpotAnims(failed, [EFFECT]);
    const manager = failed['npcInstanceManager'];
    const real = manager.loadNpcType.bind(manager);
    vi.spyOn(manager, 'loadNpcType').mockImplementation((id, ...rest) =>
      id === MINION ? Promise.reject(new Error('model missing')) : real(id, ...rest),
    );
    await failed.loadNpc(loader, animation);
    expect(assetState(failed)).toBe('unavailable');

    // An encounter switch or reload builds a new scene, which owns no record of the failure.
    const next = sceneWith(WITH_PRIMARY);
    installSyntheticSpotAnims(next, [EFFECT]);
    await next.loadNpc(loader, animation);

    expect(next.isNpcTypeLoaded(MINION)).toBe(true);
    expect(assetState(next)).toBe('ready');
  });
});

describe('encounter replay readiness', () => {
  it('holds a 3D replay frame while a declared NPC type is pending, never a 2D one, and releases it once it fails', async () => {
    const scene = sceneWith(WITH_PRIMARY);
    installSyntheticSpotAnims(scene, [EFFECT]);
    const manager = scene['npcInstanceManager'];
    let fail: ((error: Error) => void) | undefined;
    const real = manager.loadNpcType.bind(manager);
    vi.spyOn(manager, 'loadNpcType').mockImplementation((id, ...rest) =>
      id === HAZARD
        ? new Promise<void>((_resolve, reject) => {
            fail = reject;
          })
        : real(id, ...rest),
    );
    const { loader, animation } = syntheticNpcAssets();

    // Never requested is pending too: nothing has loaded yet.
    expect(assetState(scene)).toBe('pending');
    const loading = scene.loadNpc(loader, animation);
    expect(assetState(scene)).toBe('pending');
    expect(drawReplay(scene, '3d').replayPresentationReady).toBe(false);
    expect(drawReplay(scene, '2d').replayPresentationReady).toBe(true);

    fail?.(new Error('cache corrupt'));
    await loading;

    expect(assetState(scene)).toBe('unavailable');
    expect(drawReplay(scene, '3d').replayPresentationReady).toBe(true);
  });

  it('holds a 3D replay frame for an unloaded effect, and treats one the cache could not supply as settled', async () => {
    const scene = sceneWith(WITH_PRIMARY);
    const { loader, animation } = syntheticNpcAssets();
    await scene.loadNpc(loader, animation);

    expect(assetState(scene)).toBe('pending');
    expect(drawReplay(scene, '3d').replayPresentationReady).toBe(false);

    // What `SpotAnimRenderer` caches for an effect with no model: loaded, with nothing to draw.
    scene['spotAnimRenderer']['meshCache'].set(EFFECT, {
      static: [],
      frames: [],
      frameLengths: [],
      frameStep: -1,
      heightOffset: 0,
    });
    expect(assetState(scene)).toBe('unavailable');
    expect(drawReplay(scene, '3d').replayPresentationReady).toBe(true);

    installSyntheticSpotAnims(scene, [EFFECT]);
    expect(assetState(scene)).toBe('ready');
  });
});

describe('the common encounter scene', () => {
  it('is what a presentation module without a scene builder gets, configured from its render config', () => {
    const eventAudioPlayer = new EventAudioPlayer(new AudioEngine());
    const frameSoundTracker = new FrameSoundTracker(new AudioEngine());
    const cacheManager = {} as CacheManager;

    const scene = sceneBuilderFactoryFor({ kind: 'common', renderConfig: WITH_PRIMARY })({
      cacheManager,
      eventAudioPlayer,
      frameSoundTracker,
    });
    if (!(scene instanceof SceneCompositor)) expect.fail('Expected the common scene');
    scenes.push(scene);

    expect(Object.getPrototypeOf(scene)).toBe(SceneCompositor.prototype);
    expect(scene['encounterRenderConfig']).toBe(WITH_PRIMARY);
    expect(scene['eventAudioPlayer']).toBe(eventAudioPlayer);
    expect(scene['frameSoundTracker']).toBe(frameSoundTracker);
    expect(scene['groundItemLoaderSource']).toBe(cacheManager);

    // The render config the app passes still wins over the module's own.
    const passed = sceneBuilderFactoryFor({ kind: 'common', renderConfig: WITH_PRIMARY })({
      cacheManager,
      encounterRenderConfig: PRIMARYLESS,
    });
    if (!(passed instanceof SceneCompositor)) expect.fail('Expected the common scene');
    scenes.push(passed);
    expect(passed['encounterRenderConfig']).toBe(PRIMARYLESS);
  });

  it("keeps a module's own scene builder, and still fails on a kind nothing registered", () => {
    const own = vi.fn();
    expect(sceneBuilderFactoryFor({ kind: 'common', sceneBuilder: own, renderConfig: WITH_PRIMARY })).toBe(own);

    const registry = new SceneBuilderRegistry();
    registry.register('common', sceneBuilderFactoryFor({ kind: 'common', renderConfig: WITH_PRIMARY }));
    expect(() => registry.create('unknown', { cacheManager: {} as CacheManager })).toThrow(
      'Unknown scene builder kind: "unknown"',
    );
  });

  it('plays frame sounds after the final pose, and only syncs them on a paused or rebuilt frame', async () => {
    const tracker = new FrameSoundTracker(new AudioEngine());
    const update = vi.spyOn(tracker, 'update');
    const silentSync = vi.spyOn(tracker, 'silentSync');
    const scene = configureEncounterScene(new SceneCompositor(), { frameSoundTracker: tracker }, PRIMARYLESS);
    scenes.push(scene);
    const { loader, animation } = syntheticNpcAssets();
    await scene.loadNpc(loader, animation);

    // The first replay frame rebuilds the scene; a paused one holds it.
    drawReplay(scene, '3d');
    drawReplay(scene, '3d', true);
    expect(update).not.toHaveBeenCalled();
    expect(silentSync).toHaveBeenCalledTimes(2);

    const state = new SimulationEngine({ encounter: new LobbyEncounter() }).getState();
    const live: RenderContext = {
      simulationState: state,
      events: [],
      interpolatedTick: 0,
      speedMultiplier: 1,
      interaction: { hoveredTile: null, targetTile: null },
      options: SCENE_OPTIONS,
    };
    scene.build(live, IDENTITY_PROJECTION, VIEWPORT);
    scene.build({ ...live, interpolatedTick: 0.5 }, IDENTITY_PROJECTION, VIEWPORT);
    expect(update).toHaveBeenCalled();
  });
});
