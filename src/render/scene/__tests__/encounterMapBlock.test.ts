import { describe, expect, it } from 'vitest';
import type { MapSquareData } from '../../../rs/map/MapLoader';
import { withDescriptorMapBlock } from '../encounterMapBlock';
import { getEncounterRenderConfig } from '../encounterRenderConfig';
import type { SceneCompositor } from '../SceneCompositor';
import { createSolHereditSceneBuilder } from '../solHereditSceneBuilder';
import type { SceneBuilder } from '../types';
import { YamaSceneBuilder } from '../yamaSceneBuilder';
import { createZukSceneBuilder } from '../zukSceneBuilder';

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

describe('withDescriptorMapBlock', () => {
  it('leaves a config for a kind with no descriptor as it is', () => {
    const config = { spotAnimIds: [1] };
    expect(withDescriptorMapBlock(config, 'not_an_encounter')).toBe(config);
  });
});

describe.each<[string, () => SceneBuilder]>([
  ['sol_heredit', () => createSolHereditSceneBuilder()],
  ['inferno', () => createZukSceneBuilder()],
  // The Yama builder wraps its compositor; the config and terrain live there.
  ['yama_p3', () => new YamaSceneBuilder()['compositor']],
])('the %s scene builder made without options', (kind, create) => {
  it("uses the app's resolved render config, the descriptor's map squares included", () => {
    const scene = create() as SceneCompositor;
    expect(scene['encounterRenderConfig']).toEqual(getEncounterRenderConfig(kind));
  });

  it("loads its terrain from the descriptor's squares", async () => {
    const scene = create() as SceneCompositor;
    const resolved = getEncounterRenderConfig(kind);
    if (!resolved?.terrainMapSquare || !resolved.mapSquareOffsets) throw new Error(`${kind}: no resolved map block`);
    const origin = resolved.terrainMapSquare;
    const loaded = new Set<string>();
    const meshes = await scene.buildTerrainMeshes3D({
      loadMapSquare: async (mapX: number, mapY: number) => {
        loaded.add(`${mapX - origin.x},${mapY - origin.y}`);
        return openSquare(mapX, mapY);
      },
    });
    expect(meshes.length).toBeGreaterThan(0);
    for (const { dx, dy } of resolved.mapSquareOffsets) expect(loaded, `${kind} ${dx},${dy}`).toContain(`${dx},${dy}`);
    scene.dispose();
  });
});
