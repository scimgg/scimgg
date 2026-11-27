import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEncounterMapFootprint } from '../../../core/encounters/mapFootprint';
import type { MapSquareData } from '../../../rs/map/MapLoader';
import { encounterScene, UNBOOTSTRAPPED_CACHE_MANAGER } from '../../../test/helpers/encounterScene';
import { ColosseumSceneCompositor } from '../ColosseumSceneCompositor';
import { getEncounterRenderConfig } from '../encounterRenderConfig';
import { InfernoSceneCompositor } from '../InfernoSceneCompositor';
import type { SceneCompositor } from '../SceneCompositor';
import { YamaSceneCompositor } from '../YamaSceneCompositor';

function openSquare(mapX: number, mapY: number): MapSquareData {
  // Three planes, for Sol's all-levels scene.
  const level = <T>(make: () => T): T[][] => Array.from({ length: 3 }, () => Array.from({ length: 65 }, make));
  return {
    mapX,
    mapY,
    tileHeights: level(() => new Int32Array(65)),
    tileUnderlays: level(() => new Uint16Array(64).fill(1)),
    tileOverlays: level(() => new Int16Array(64)),
    tileShapes: level(() => new Uint8Array(64)),
    tileRotations: level(() => new Uint8Array(64)),
    tileRenderFlags: level(() => new Uint8Array(64)),
    tileLightOcclusions: level(() => new Uint8Array(64)),
  };
}

/** Loads `scene`'s 3D terrain, returning each square it read as `dx,dy` from `origin`. */
async function loadedTerrainSquares(scene: SceneCompositor, origin: { x: number; y: number }): Promise<Set<string>> {
  const loaded = new Set<string>();
  const meshes = await scene.buildTerrainMeshes3D({
    loadMapSquare: async (mapX: number, mapY: number) => {
      loaded.add(`${mapX - origin.x},${mapY - origin.y}`);
      return openSquare(mapX, mapY);
    },
  });
  expect(meshes.length).toBeGreaterThan(0);
  return loaded;
}

const PRESENTATION_MODULES = '../../../encounters/presentationModules';

describe('a registered encounter with a render config and no presentation row', () => {
  afterEach(() => {
    vi.doUnmock(PRESENTATION_MODULES);
    vi.resetModules();
  });

  it("gets the common scene on its descriptor's terrain squares from the production entry point", async () => {
    // A fresh module graph whose presentation manifest has no Sol Heredit row.
    vi.resetModules();
    vi.doMock(PRESENTATION_MODULES, async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../encounters/presentationModules')>();
      return {
        ...actual,
        ENCOUNTER_PRESENTATION_MODULES: actual.ENCOUNTER_PRESENTATION_MODULES.filter(
          (row) => row.kind !== 'sol_heredit',
        ),
        encounterPresentationModuleForKind: (kind: string) =>
          kind === 'sol_heredit' ? undefined : actual.encounterPresentationModuleForKind(kind),
      };
    });
    const { createSceneBuilderForKind } = await import('../sceneBuilderFactory');
    const { SceneCompositor: FreshSceneCompositor } = await import('../SceneCompositor');
    const { ColosseumSceneCompositor: FreshColosseum } = await import('../ColosseumSceneCompositor');
    const { encounterRegistry } = await import('../../../encounters/registry');
    const { ENCOUNTER_RENDER_CONFIGS } = await import('../../../encounters/renderConfigs');

    const scene = createSceneBuilderForKind('sol_heredit', { cacheManager: UNBOOTSTRAPPED_CACHE_MANAGER });
    if (!(scene instanceof FreshSceneCompositor) || scene instanceof FreshColosseum)
      expect.fail('Expected the common scene');
    expect(scene['encounterRenderConfig']?.preloadNpcTypes).toBe(
      ENCOUNTER_RENDER_CONFIGS.get('sol_heredit')?.preloadNpcTypes,
    );
    const descriptor = encounterRegistry.getDescriptorForKind('sol_heredit');
    if (!descriptor) expect.fail('sol_heredit has no descriptor');
    const footprint = resolveEncounterMapFootprint(descriptor);
    const loaded = await loadedTerrainSquares(scene, footprint.origin);
    for (const { dx, dy } of footprint.sceneOffsets) expect(loaded, `${dx},${dy}`).toContain(`${dx},${dy}`);
    scene.dispose();
  });
});

describe.each<[string, abstract new () => SceneCompositor]>([
  ['sol_heredit', ColosseumSceneCompositor],
  ['inferno', InfernoSceneCompositor],
  ['yama_p3', YamaSceneCompositor],
])('the %s scene made without a render config', (kind, compositor) => {
  it("uses the app's resolved render config, the descriptor's map squares included", () => {
    const scene = encounterScene(kind, compositor);
    expect(scene['encounterRenderConfig']).toBe(getEncounterRenderConfig(kind));
    scene.dispose();
  });

  it("loads its terrain from the descriptor's squares", async () => {
    const scene = encounterScene(kind, compositor);
    const resolved = getEncounterRenderConfig(kind);
    if (!resolved?.terrainMapSquare || !resolved.mapSquareOffsets) throw new Error(`${kind}: no resolved map block`);
    const loaded = await loadedTerrainSquares(scene, resolved.terrainMapSquare);
    for (const { dx, dy } of resolved.mapSquareOffsets) expect(loaded, `${kind} ${dx},${dy}`).toContain(`${dx},${dy}`);
    scene.dispose();
  });
});
