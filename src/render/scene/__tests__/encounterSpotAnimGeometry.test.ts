import { afterEach, describe, expect, it, vi } from 'vitest';
import { YAMA_ENCOUNTER_RENDER_CONFIG } from '../../../encounters/yamaP3/renderConfig';
import type { CacheInfo } from '../../../rs/cache/CacheInfo';
import { CacheSystem } from '../../../rs/cache/CacheSystem';
import { Bzip2 } from '../../../rs/compression/Bzip2';
import { ArchiveSeqTypeLoader } from '../../../rs/config/seqtype/SeqTypeLoader';
import { ArchiveSpotAnimTypeLoader } from '../../../rs/config/spotanimtype/SpotAnimTypeLoader';
import { IndexModelLoader } from '../../../rs/model/ModelLoader';
import { SpotAnimModelLoader } from '../../../rs/model/SpotAnimModelLoader';
import { readCacheZipFiles } from '../../../test/helpers/cacheZipFiles';
import { collectGarbage, collectGarbageUntilCleared } from '../../../test/helpers/collectGarbage';
import { encounterScene } from '../../../test/helpers/encounterScene';
import {
  findProjectCacheZip,
  REAL_CACHE_TEST_TIMEOUT_MS,
  skipWithoutRealCache,
} from '../../../test/helpers/real-cache';
import { ResidentMeshEmbedder } from '../../../test/helpers/residentMeshDraws';
import { expectSameBytes } from '../../../test/helpers/sameBytes';
import { spotAnimPartArrays } from '../../../test/helpers/spotAnimResidentParts';
import { perfFlags } from '../../../util/PerfFlags';
import { AnimationSystem } from '../../backends/picogl/AnimationSystem';
import { isResidentMesh3DCommand, type NpcMesh3DCommand, type RenderCommand } from '../../core/commands';
import type { ImmutableMeshSource } from '../../core/meshSource';
import type { SpotAnimRenderer } from '../../effects/SpotAnimRenderer';
import type { SpotAnimEmbeddedPart, SpotAnimMeshPart } from '../../effects/spotAnimMeshParts';
import { ColosseumSceneCompositor } from '../ColosseumSceneCompositor';
import { InfernoSceneCompositor } from '../InfernoSceneCompositor';
import { LobbySceneCompositor } from '../lobby/LobbySceneCompositor';
import type { SceneCompositor } from '../SceneCompositor';
import { YamaSceneCompositor } from '../YamaSceneCompositor';
import goldenFile from './encounterSpotAnimDrawGoldens.json';
import {
  digestSpotAnimRenderer,
  type SpotAnimDigestEncounter,
  type SpotAnimDrawGoldenFile,
  sha256File,
} from './encounterSpotAnimDraws';

/**
 * Every encounter's preloaded spotanims, baked from the real cache, must match the baseline digests
 * and scoped overrides in `encounterSpotAnimDrawGoldens.json`: every non-normal attribute on both
 * transparent paths. A restart must reuse the same geometry, and the sources resident draws
 * name must rebuild it byte for byte, as after a lost context.
 */

const cachePath = findProjectCacheZip() ?? '';
const info: CacheInfo = {
  name: 'osrs-test',
  game: 'oldschool',
  environment: 'live',
  revision: 232,
  timestamp: '',
  size: 0,
};

const goldens = goldenFile as SpotAnimDrawGoldenFile;

const ENCOUNTERS: ReadonlyArray<readonly [SpotAnimDigestEncounter, () => SceneCompositor]> = [
  ['sol_heredit', () => encounterScene('sol_heredit', ColosseumSceneCompositor)],
  ['inferno', () => encounterScene('inferno', InfernoSceneCompositor)],
  [
    'yama_p3',
    () => {
      const scene = new YamaSceneCompositor();
      scene.setEncounterRenderConfig(YAMA_ENCOUNTER_RENDER_CONFIG);
      return scene;
    },
  ],
  ['lobby', () => new LobbySceneCompositor(0, 0, 0)],
];

const initialSkipSort = perfFlags.skipTransparentSort;
const scenes: SceneCompositor[] = [];
/**
 * Reads resident parts and draws as the arrays the renderer uploads: each source is materialized
 * once, as the renderer's first upload does, and every later read of it sees that upload.
 */
let embedder = new ResidentMeshEmbedder();
afterEach(() => {
  perfFlags.skipTransparentSort = initialSkipSort;
  for (const scene of scenes.splice(0)) scene.dispose();
  vi.restoreAllMocks();
  embedder = new ResidentMeshEmbedder();
});

function arraysOf(part: SpotAnimMeshPart): SpotAnimEmbeddedPart {
  return spotAnimPartArrays(embedder, part);
}

let cacheFiles: Promise<Map<string, ArrayBuffer>> | undefined;
async function openCache(): Promise<CacheSystem> {
  cacheFiles ??= (async () => {
    const files = await readCacheZipFiles(cachePath);
    await Bzip2.initWasm();
    return files;
  })();
  return cacheFiles.then((files) => CacheSystem.fromMap('dat2', files, [0, 1, 2, 7, 22]));
}

async function openLoaders(): Promise<{ animation: AnimationSystem; createLoader: () => SpotAnimModelLoader }> {
  const cache = await openCache();
  const config = cache.getIndex(2);
  const animation = new AnimationSystem();
  animation.initialize(info, cache.getIndex(0), cache.getIndex(1), config.getArchive(12), cache.getIndex(22));
  const frameLoader = animation.getSeqFrameLoader();
  if (!frameLoader) throw new Error('missing frame loader');
  return {
    animation,
    createLoader: () =>
      new SpotAnimModelLoader(
        new ArchiveSpotAnimTypeLoader(info, config.getArchive(13)),
        new IndexModelLoader(cache.getIndex(7)),
        new ArchiveSeqTypeLoader(info, config.getArchive(12)),
        frameLoader,
      ),
  };
}

async function loadScene(
  create: () => SceneCompositor,
  loader: SpotAnimModelLoader,
  animation: AnimationSystem,
): Promise<SpotAnimRenderer> {
  const scene = create();
  scenes.push(scene);
  const renderer = scene['spotAnimRenderer'];
  renderer.setAnimationSystem(animation);
  await scene.loadSpotAnims(loader);
  return renderer;
}

/**
 * Collects what the draws a digest makes hand the GPU backend to rebuild from: the arrays of baked
 * embedded draws and the sources of resident ones. Sorted and posed draws carry per-frame arrays.
 */
function queuedGeometry() {
  const arrays = new Set<Float32Array>();
  const sources = new Set<ImmutableMeshSource>();
  const command = (queued: RenderCommand): RenderCommand => {
    if (queued.kind === 'mesh3d' && isResidentMesh3DCommand(queued)) sources.add(queued.meshSource);
    else if (queued.kind === 'mesh3d' && !(queued as NpcMesh3DCommand).animated) {
      arrays.add((queued as NpcMesh3DCommand).positions);
    }
    return embedder.embed(queued);
  };
  return { arrays, sources, command };
}

describe.skipIf(skipWithoutRealCache())('encounter spotanim geometry from the real cache', () => {
  it.skipIf(!collectGarbage).each(ENCOUNTERS)(
    '%s keeps no CPU copy of opaque geometry once the renderer has uploaded it',
    async (_name, create) => {
      const { animation, createLoader } = await openLoaders();
      const renderer = await loadScene(create, createLoader(), animation);
      const sources = new Set<ImmutableMeshSource>();
      for (const entry of renderer['meshCache'].values()) {
        for (const part of [entry.static, ...entry.frames].flat()) if (part.resident) sources.add(part.resident.source);
      }
      expect(sources.size).toBeGreaterThan(0);
      // The upload takes the build made while loading; afterwards nothing on the CPU holds it.
      const released = [...sources].flatMap((source) =>
        source.materialize().map((part) => new WeakRef(part.positions)),
      );
      await collectGarbageUntilCleared(released);
      expect(released.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
      expect(renderer['meshCache'].size).toBeGreaterThan(0);
    },
    REAL_CACHE_TEST_TIMEOUT_MS,
  );

  it.each(ENCOUNTERS)(
    '%s matches the documented bake/draw goldens, and a restart reuses the geometry',
    async (name, create) => {
      expect(sha256File(cachePath), 'goldens were recorded from another test cache').toBe(goldens.cache.sha256);
      const { animation, createLoader } = await openLoaders();
      const loader = createLoader();
      const first = await loadScene(create, loader, animation);
      const firstQueued = queuedGeometry();
      expect(digestSpotAnimRenderer(first, perfFlags, { part: arraysOf, command: firstQueued.command })).toEqual(
        goldens.encounters[name],
      );
      expect(firstQueued.sources.size).toBeGreaterThan(0);
      const snapshots = new Map([...firstQueued.arrays].map((positions) => [positions, positions.slice()]));

      // A restart builds a new compositor on the same loader and disposes the old one.
      const firstEntries = new Map(first['meshCache']);
      for (const scene of scenes.splice(0)) scene.dispose();
      const bake = vi.spyOn(loader, 'loadAnimatedSpotAnim');
      const restarted = await loadScene(create, loader, animation);
      const restartedQueued = queuedGeometry();
      expect(
        digestSpotAnimRenderer(restarted, perfFlags, { part: arraysOf, command: restartedQueued.command }),
      ).toEqual(goldens.encounters[name]);
      expect(bake).not.toHaveBeenCalled();
      bake.mockRestore();
      for (const [id, entry] of restarted['meshCache']) {
        if (!restarted['skeletalPosers'].has(id)) expect(entry).toBe(firstEntries.get(id));
      }

      // After a context loss embedded draws re-upload the same, unmodified arrays, and resident
      // ones rebuild from their recipes exactly what was first uploaded.
      const restartedArrays = [...restartedQueued.arrays];
      const firstArrays = [...firstQueued.arrays];
      expect(restartedArrays.length).toBe(firstArrays.length);
      for (const [index, positions] of restartedArrays.entries()) expectSameBytes(positions, firstArrays[index]);
      for (const [positions, snapshot] of snapshots) expectSameBytes(positions, snapshot);
      expect([...restartedQueued.sources]).toEqual([...firstQueued.sources]);
      for (const source of restartedQueued.sources) {
        for (const [part, rebuilt] of source.materialize().entries()) {
          const uploaded = embedder.embedResident({
            kind: 'mesh3d',
            meshId: source.id,
            materialId: 'osrs-npc',
            modelMatrix: new Float32Array(16),
            meshSource: source,
            meshSourcePart: part,
          });
          expectSameBytes(rebuilt.positions, uploaded.positions);
          expectSameBytes(rebuilt.perVertexHslColors, uploaded.perVertexHslColors);
          expectSameBytes(rebuilt.perVertexAlphas, uploaded.perVertexAlphas);
          expectSameBytes(rebuilt.perVertexFaceBias, uploaded.perVertexFaceBias);
        }
      }
    },
    120_000,
  );
});
