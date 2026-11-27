import { describe, expect, it, vi } from 'vitest';
import { AudioEngine, EventAudioPlayer, FrameSoundTracker } from '../../audio';
import type { CacheManager } from '../../cache/CacheManager';
import { resolveEncounterMapFootprint } from '../../core/encounters/mapFootprint';
import { SimulationEngine } from '../../core/SimulationEngine';
import { LobbyEncounter } from '../../encounters/lobby/LobbyEncounter';
import { encounterRegistry } from '../../encounters/registry';
import { YAMA_ENCOUNTER_RENDER_CONFIG } from '../../encounters/yamaP3/renderConfig';
import type { OverlayType } from '../../rs/config/flotype/FloType';
import type { OverlayTypeLoader, UnderlayTypeLoader } from '../../rs/config/flotype/FloTypeLoader';
import type { MapLoader, MapSquareData } from '../../rs/map/MapLoader';
import { collectGarbage, collectGarbageUntilCleared } from '../../test/helpers/collectGarbage';
import { expectSameBytes } from '../../test/helpers/sameBytes';
import type { Projection2D } from '../core/camera';
import type { MeshUploadAttribute } from '../core/meshSource';
import type { SceneBuilderOptions } from './sceneBuilderFactory';
import type { RenderContext } from './types';
import { YamaSceneCompositor } from './YamaSceneCompositor';
import { createYamaSceneBuilder } from './yamaSceneBuilder';

function yamaScene(options?: Partial<SceneBuilderOptions>): YamaSceneCompositor {
  const scene = createYamaSceneBuilder(options);
  if (!(scene instanceof YamaSceneCompositor)) throw new Error('Expected the Yama compositor');
  return scene;
}

function createMockOverlayLoader(textureMap: Map<number, number>): OverlayTypeLoader {
  return {
    load: (id: number) => {
      const texture = textureMap.get(id) ?? -1;
      return { texture } as OverlayType;
    },
    getIds: () => [...textureMap.keys()],
    getCount: () => textureMap.size,
    clearCache: () => {},
  } as unknown as OverlayTypeLoader;
}

function createMockUnderlayLoader(): UnderlayTypeLoader {
  return {
    load: () => ({
      hue: 30,
      saturation: 128,
      lightness: 128,
      hueMultiplier: 1,
    }),
    getIds: () => [0],
    getCount: () => 1,
    clearCache: () => {},
  } as unknown as UnderlayTypeLoader;
}

function createMockMapData(width: number, height: number): MapSquareData {
  const tileHeights: Int32Array[][] = [];
  const tileUnderlays: Uint16Array[][] = [];
  const tileOverlays: Int16Array[][] = [];
  const tileShapes: Uint8Array[][] = [];
  const tileRotations: Uint8Array[][] = [];
  const tileRenderFlags: Uint8Array[][] = [];
  const tileLightOcclusions: Uint8Array[][] = [];

  for (let level = 0; level < 4; level++) {
    tileHeights[level] = [];
    tileUnderlays[level] = [];
    tileOverlays[level] = [];
    tileShapes[level] = [];
    tileRotations[level] = [];
    tileRenderFlags[level] = [];
    tileLightOcclusions[level] = [];

    for (let x = 0; x <= width; x++) {
      tileHeights[level][x] = new Int32Array(height + 1);
      tileLightOcclusions[level][x] = new Uint8Array(height + 1);
    }

    for (let x = 0; x < width; x++) {
      tileUnderlays[level][x] = new Uint16Array(height);
      tileUnderlays[level][x].fill(1);
      tileOverlays[level][x] = new Int16Array(height);
      tileShapes[level][x] = new Uint8Array(height);
      tileRotations[level][x] = new Uint8Array(height);
      tileRenderFlags[level][x] = new Uint8Array(height);
    }
  }

  return {
    mapX: 23,
    mapY: 157,
    tileHeights,
    tileUnderlays,
    tileOverlays,
    tileShapes,
    tileRotations,
    tileRenderFlags,
    tileLightOcclusions,
  };
}

describe('createYamaSceneBuilder', () => {
  it("is the Yama compositor itself, with Yama's render config and descriptor map block unless the options give one", () => {
    const descriptor = encounterRegistry.getDescriptorForKind('yama_p3');
    if (!descriptor) throw new Error('yama_p3 has no descriptor');
    const footprint = resolveEncounterMapFootprint(descriptor);
    const scene = yamaScene();
    expect(scene['encounterRenderConfig']).toEqual({
      ...YAMA_ENCOUNTER_RENDER_CONFIG,
      terrainMapSquare: footprint.origin,
      mapSquareOffsets: footprint.sceneOffsets,
      arenaMapSquareOffsets: footprint.arenaOffsets,
    });
    scene.dispose();

    const encounterRenderConfig = { terrainMapSquare: { x: 1, y: 2 } };
    const eventAudioPlayer = new EventAudioPlayer(new AudioEngine());
    const frameSoundTracker = new FrameSoundTracker(new AudioEngine());
    const cacheManager = {} as CacheManager;
    const passed = yamaScene({ encounterRenderConfig, eventAudioPlayer, frameSoundTracker, cacheManager });
    expect(passed['encounterRenderConfig']).toBe(encounterRenderConfig);
    expect(passed['eventAudioPlayer']).toBe(eventAudioPlayer);
    expect(passed['frameSoundTracker']).toBe(frameSoundTracker);
    expect(passed['groundItemLoaderSource']).toBe(cacheManager);
    passed.dispose();
  });

  it('reports the intro animation time left at the playback speed, only while the intro plays', () => {
    const scene = yamaScene();
    expect(scene.getIntroAnimationRemainingMs(1)).toBeNull();
    Reflect.set(scene, 'playerAnimController', { getIntroRemainingAnimMs: () => 1200 });
    expect(scene.getIntroAnimationRemainingMs(1)).toBeNull();

    Reflect.set(scene, '_introAnimPlaying', true);
    expect(scene.getIntroAnimationRemainingMs(1)).toBe(1200);
    expect(scene.getIntroAnimationRemainingMs(2)).toBeNull();
    Reflect.set(scene, 'speedMultiplier', 2);
    expect(scene.getIntroAnimationRemainingMs(2)).toBe(600);
    expect(scene.getIntroAnimationRemainingMs(1)).toBeNull();
    scene.dispose();
  });

  it('rejects the old renderer tempo across skipped frames until a real build updates the compositor', () => {
    const scene = yamaScene();
    const controller = { getIntroRemainingAnimMs: () => 3500 };
    Reflect.set(scene, 'playerAnimController', controller);
    Reflect.set(scene, '_introAnimPlaying', true);
    expect(scene.getIntroAnimationRemainingMs(1)).toBe(3500);
    // Calling the timing getter for skipped RAFs must not acknowledge a speed change.
    for (let skipped = 0; skipped < 3; skipped++) expect(scene.getIntroAnimationRemainingMs(2)).toBeNull();

    const context: RenderContext = {
      simulationState: new SimulationEngine({ encounter: new LobbyEncounter() }).getState(),
      events: [],
      interaction: { hoveredTile: null, targetTile: null },
      interpolatedTick: 0,
      speedMultiplier: 2,
      options: {
        renderMode: '2d',
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
    };
    const projection: Projection2D = {
      tileToScreen: (tile) => tile,
      tileDeltaToScreen: (delta) => delta,
      screenToTile: () => null,
      tilePolygonScreen: () => [],
    };
    // Only the timing source is stubbed; the renderer build's tempo assignment is real.
    Reflect.set(scene, 'playerAnimController', null);
    scene.build(context, projection, { width: 800, height: 600, dpr: 1 });
    Reflect.set(scene, 'playerAnimController', controller);
    expect(scene.getIntroAnimationRemainingMs(2)).toBe(1750);
    expect(scene.getIntroAnimationRemainingMs(1)).toBeNull();
    scene.dispose();
  });

  it('builds mesh3d command with terrain buffers', async () => {
    const mapData = createMockMapData(64, 64);
    mapData.tileOverlays[0][0][0] = 5;
    mapData.tileShapes[0][0][0] = 1;

    const mapLoader = {
      loadMapSquare: vi.fn().mockResolvedValue(mapData),
    } as unknown as MapLoader;

    const overlayLoader = createMockOverlayLoader(new Map([[4, 5]]));

    // The mock square sits at 23,157, so name it rather than take the descriptor's origin.
    const builder = yamaScene({ encounterRenderConfig: { terrainMapSquare: { x: 23, y: 157 } } });
    const underlayLoader = createMockUnderlayLoader();
    const command = await builder.buildTerrainMesh3D(mapLoader, underlayLoader, overlayLoader);

    expect(mapLoader.loadMapSquare).toHaveBeenCalledWith(23, 157);
    expect(command.kind).toBe('mesh3d');
    expect(command.meshSourcePart).toBe(0);
    const [mesh] = command.meshSource.materialize();
    if (!mesh) throw new Error('Expected one terrain part');
    expect(mesh.positions).toBeInstanceOf(Float32Array);
    // Terrain draws with scene-base, which reads no normals.
    expect(mesh).not.toHaveProperty('normals');
    expect(mesh.uvs).toBeInstanceOf(Float32Array);
    expect(mesh.indices).toBeInstanceOf(Uint16Array);
    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.uvs?.length).toBe((mesh.positions.length / 3) * 2);
    expect(mesh.indices?.length).toBe(mesh.positions.length / 3);
    expect(command.meshSource.parts).toEqual([
      expect.objectContaining({
        vertexCount: mesh.positions.length / 3,
        attributes: ['positions', 'indices', 'uvs', 'perVertexTextureIds', 'perVertexHslColors', 'tileCoords'],
      }),
    ]);
    expect(command.textureIds).toContain(5);
    expect(command.modelMatrix.length).toBe(16);

    // After an eviction or a lost context the renderer rebuilds the same bytes from the recipe,
    // without loading the map again.
    const [rebuilt] = command.meshSource.materialize();
    if (!rebuilt) throw new Error('Expected one rebuilt terrain part');
    // Not `not.toBe`/`toEqual`: on distinct objects both deep-walk every array element, taking seconds here.
    expect(rebuilt === mesh).toBe(false);
    expect(Object.keys(rebuilt)).toEqual(Object.keys(mesh));
    for (const name of Object.keys(mesh) as MeshUploadAttribute[]) expectSameBytes(rebuilt[name], mesh[name], name);
    expect(mapLoader.loadMapSquare).toHaveBeenCalledTimes(9);
  });

  it.skipIf(!collectGarbage)('keeps no CPU copy of a terrain mesh once the renderer has taken it', async () => {
    const mapData = createMockMapData(64, 64);
    const builder = yamaScene({ encounterRenderConfig: { terrainMapSquare: { x: 23, y: 157 } } });
    const command = await builder.buildTerrainMesh3D(
      { loadMapSquare: vi.fn().mockResolvedValue(mapData) } as unknown as MapLoader,
      createMockUnderlayLoader(),
      createMockOverlayLoader(new Map()),
    );
    const arrays = command.meshSource
      .materialize()
      .flatMap((part) => Object.values(part))
      .map((array) => new WeakRef(array));

    await collectGarbageUntilCleared(arrays);

    expect(arrays.length).toBe(6);
    expect(arrays.map((array) => array.deref())).toEqual(arrays.map(() => undefined));
    expect(command.meshSource.materialize()[0]?.positions.length).toBe(
      (command.meshSource.parts[0]?.vertexCount ?? 0) * 3,
    );
  });
});
