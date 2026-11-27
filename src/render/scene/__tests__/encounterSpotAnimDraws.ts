/**
 * Digests what `SpotAnimRenderer` bakes and draws for every encounter's preloaded spotanims, for
 * `encounterSpotAnimGeometry.test.ts`, and regenerates its goldens (`encounterSpotAnimDrawGoldens.json`)
 * from the checkout at `--renderer-root`; the fixture's `regenerate` field holds the command.
 * Normals are excluded: spotanims draw with scene-base, which reads none, and the test checks
 * separately that none are kept.
 */

import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  findTestCacheForGenerator,
  readCacheZipFiles,
  regenerateCommand,
  rendererRootArgument,
  sha256File,
  writeGoldenFixture,
} from '../../../test/helpers/cacheFixtures';

export { sha256File };

export const SPOTANIM_DIGEST_ENCOUNTERS = ['sol_heredit', 'inferno', 'yama_p3', 'lobby'] as const;
export type SpotAnimDigestEncounter = (typeof SPOTANIM_DIGEST_ENCOUNTERS)[number];

/** One effect: its baked parts, and every frame drawn on the skip-sort and full-sort paths. */
export interface SpotAnimEffectDigest {
  readonly bake: string;
  readonly skipSort: string;
  readonly fullSort: string;
}

export type EncounterSpotAnimDigests = Record<SpotAnimDigestEncounter, Record<string, SpotAnimEffectDigest>>;

export interface SpotAnimDrawGoldenFile {
  readonly about: string;
  readonly regenerate: string;
  readonly cache: { readonly file: string; readonly sha256: string };
  readonly encounters: EncounterSpotAnimDigests;
}

const SORTER_CAMERA = {
  cameraX: 2044,
  cameraY: -1800,
  cameraZ: 24,
  yawSin: 0.2,
  yawCos: Math.sqrt(0.96),
  pitchSin: 0.5,
  pitchCos: Math.sqrt(0.75),
};
const TRANSFORM = { position: [10.5, 20.5, 0] as [number, number, number], yaw2048: 333 };
const SKELETAL_SAMPLES = 8;

// Loose shapes: both the embedded and the GPU-resident part and command shapes are read.
type Loose = any;

type Hash = ReturnType<typeof createHash>;

function bytes(hash: Hash, label: string, array: ArrayBufferView | undefined | null): void {
  hash.update(`${label}:`);
  if (!array) {
    hash.update('-;');
    return;
  }
  hash.update(`${array.constructor.name}/${array.byteLength};`);
  hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
}

function digestAttributes(hash: Hash, mesh: Loose): void {
  hash.update(
    JSON.stringify([
      mesh.meshId,
      mesh.materialId,
      mesh.depth,
      mesh.blend,
      // Resident draws carry no `animated`; embedded baked parts always carry false.
      mesh.animated ?? false,
      mesh.cullFace,
      mesh.zIndex,
      mesh.depthBias,
      mesh.shaderId,
    ]),
  );
  bytes(hash, 'positions', mesh.positions);
  bytes(hash, 'hsl', mesh.perVertexHslColors);
  bytes(hash, 'alphas', mesh.perVertexAlphas);
  bytes(hash, 'faceBias', mesh.perVertexFaceBias);
  bytes(hash, 'uvs', mesh.uvs);
  bytes(hash, 'textureIds', mesh.perVertexTextureIds);
}

/**
 * The sorter input a transparent part feeds, in a form both part shapes reduce to: an embedded part
 * copies vertex coordinates and keeps a face map; a resident part reads the coordinates from
 * `positions` and keeps only the face ids.
 */
function digestSortInput(hash: Hash, part: Loose): void {
  const sort = part.transparentSort;
  if (!sort) {
    hash.update('nosort;');
    return;
  }
  const model = sort.model;
  const vertices = new Float64Array(model.verticesCount * 3);
  for (let vertex = 0; vertex < model.verticesCount; vertex++) {
    vertices[vertex * 3] = model.verticesX ? model.verticesX[vertex] : part.positions[vertex * 3];
    vertices[vertex * 3 + 1] = model.verticesY ? model.verticesY[vertex] : part.positions[vertex * 3 + 1];
    vertices[vertex * 3 + 2] = model.verticesZ ? model.verticesZ[vertex] : part.positions[vertex * 3 + 2];
  }
  bytes(hash, 'sortVertices', vertices);
  hash.update(JSON.stringify([model.verticesCount, model.faceCount, model.priority, model.faceRenderPriorities]));
  bytes(hash, 'indices1', Int32Array.from(model.indices1));
  bytes(hash, 'indices2', Int32Array.from(model.indices2));
  bytes(hash, 'indices3', Int32Array.from(model.indices3));
  bytes(hash, 'faceAlphas', model.faceAlphas);
  bytes(hash, 'faceColors3', Float32Array.from(model.faceColors3));
  bytes(hash, 'triToModelFace', Uint32Array.from(sort.faceMap ? sort.faceMap.triToModelFace : sort.triToModelFace));
}

function frameProgresses(frameLengths: readonly number[], skeletal: boolean): number[] {
  if (skeletal) return Array.from({ length: SKELETAL_SAMPLES }, (_, index) => (index + 0.5) / SKELETAL_SAMPLES);
  const total = frameLengths.reduce((sum, length) => sum + length, 0);
  if (frameLengths.length === 0 || total <= 0) return [0];
  let elapsed = 0;
  return frameLengths.map((length) => {
    const middle = (elapsed + length / 2) / total;
    elapsed += length;
    return middle;
  });
}

/**
 * How a renderer's parts and commands reach their arrays: GPU-resident spotanim geometry passes the
 * resident-mesh adapter (`ResidentMeshEmbedder`); embedded geometry is read as is by the identity
 * default.
 */
export interface SpotAnimArrayAccess {
  part(part: Loose): Loose;
  command(command: Loose): Loose;
}

const EMBEDDED_ONLY: SpotAnimArrayAccess = { part: (part) => part, command: (command) => command };

/** Digests every effect a `SpotAnimRenderer` has loaded, drawing each frame on both paths. */
export function digestSpotAnimRenderer(
  renderer: Loose,
  perfFlags: { skipTransparentSort: boolean },
  arrays: SpotAnimArrayAccess = EMBEDDED_ONLY,
): Record<string, SpotAnimEffectDigest> {
  const digests: Record<string, SpotAnimEffectDigest> = {};
  const initialSkip = perfFlags.skipTransparentSort;
  renderer.setSorterProjection(SORTER_CAMERA);
  const ids = [...renderer.meshCache.keys()].sort((a: number, b: number) => a - b);
  for (const id of ids) {
    const entry = renderer.meshCache.get(id);
    const bake = createHash('sha256');
    bake.update(JSON.stringify([entry.frameLengths, entry.frameStep, entry.heightOffset, entry.seqType?.id]));
    for (const parts of [entry.static, ...entry.frames]) {
      bake.update('|');
      for (const part of parts) {
        const embedded = arrays.part(part);
        digestAttributes(bake, embedded);
        digestSortInput(bake, embedded);
      }
    }
    const draws: Record<'skipSort' | 'fullSort', string> = { skipSort: '', fullSort: '' };
    for (const path of ['skipSort', 'fullSort'] as const) {
      perfFlags.skipTransparentSort = path === 'skipSort';
      const draw = createHash('sha256');
      for (const frameProgress of frameProgresses(entry.frameLengths, renderer.skeletalPosers.has(id))) {
        renderer.upsert({
          instanceId: 'spotanim-digest',
          spotAnimId: id,
          lifecycle: { kind: 'manual' },
          transform: { kind: 'static', value: TRANSFORM },
          frameProgress,
        });
        const queue = { replayPresentationReady: true, commands: [] as Loose[] };
        renderer.render(queue);
        draw.update('|');
        for (const queued of queue.commands) {
          if (queued.kind !== 'mesh3d') continue;
          const command = arrays.command(queued);
          digestAttributes(draw, command);
          bytes(draw, 'matrix', command.modelMatrix);
        }
      }
      draws[path] = draw.digest('hex').slice(0, 16);
    }
    renderer.despawn('spotanim-digest');
    digests[id] = { bake: bake.digest('hex').slice(0, 16), ...draws };
  }
  perfFlags.skipTransparentSort = initialSkip;
  return digests;
}

/** Everything one revision's spotanim pipeline needs, imported from that revision's checkout. */
export interface SpotAnimPipeline {
  createLoader(): Loose;
  createScene(encounter: SpotAnimDigestEncounter): Loose;
  animation: Loose;
  perfFlags: { skipTransparentSort: boolean };
}

export async function loadSpotAnimPipeline(root: string, cachePath: string): Promise<SpotAnimPipeline> {
  const from = (path: string): Promise<Loose> => import(pathToFileURL(join(root, path)).href);
  const [
    { CacheSystem },
    { Bzip2 },
    { ArchiveSeqTypeLoader },
    { ArchiveSpotAnimTypeLoader },
    { IndexModelLoader },
    { SpotAnimModelLoader },
    { AnimationSystem },
    { perfFlags },
    { createSceneBuilderForKind },
    { UNBOOTSTRAPPED_CACHE_MANAGER },
    { YamaSceneCompositor },
    { YAMA_ENCOUNTER_RENDER_CONFIG },
    { LobbySceneCompositor },
  ] = await Promise.all([
    from('src/rs/cache/CacheSystem.ts'),
    from('src/rs/compression/Bzip2.ts'),
    from('src/rs/config/seqtype/SeqTypeLoader.ts'),
    from('src/rs/config/spotanimtype/SpotAnimTypeLoader.ts'),
    from('src/rs/model/ModelLoader.ts'),
    from('src/rs/model/SpotAnimModelLoader.ts'),
    from('src/render/backends/picogl/AnimationSystem.ts'),
    from('src/util/PerfFlags.ts'),
    from('src/render/scene/sceneBuilderFactory.ts'),
    from('src/test/helpers/encounterScene.ts'),
    from('src/render/scene/YamaSceneCompositor.ts'),
    from('src/encounters/yamaP3/renderConfig.ts'),
    from('src/render/scene/lobby/LobbySceneCompositor.ts'),
  ]);
  const info = { name: 'osrs-test', game: 'oldschool', environment: 'live', revision: 232, timestamp: '', size: 0 };
  await Bzip2.initWasm();
  const cache = CacheSystem.fromMap('dat2', await readCacheZipFiles(cachePath), [0, 1, 2, 7, 22]);
  const config = cache.getIndex(2);
  const animation = new AnimationSystem();
  animation.initialize(info, cache.getIndex(0), cache.getIndex(1), config.getArchive(12), cache.getIndex(22));
  const frameLoader = animation.getSeqFrameLoader();
  if (!frameLoader) throw new Error('missing sequence frame loader');
  return {
    animation,
    perfFlags,
    createLoader: () =>
      new SpotAnimModelLoader(
        new ArchiveSpotAnimTypeLoader(info, config.getArchive(13)),
        new IndexModelLoader(cache.getIndex(7)),
        new ArchiveSeqTypeLoader(info, config.getArchive(12)),
        frameLoader,
      ),
    createScene: (encounter) => {
      switch (encounter) {
        case 'sol_heredit':
        case 'inferno':
          return createSceneBuilderForKind(encounter, { cacheManager: UNBOOTSTRAPPED_CACHE_MANAGER });
        case 'yama_p3': {
          const scene = new YamaSceneCompositor();
          scene.setEncounterRenderConfig(YAMA_ENCOUNTER_RENDER_CONFIG);
          return scene;
        }
        case 'lobby':
          return new LobbySceneCompositor(0, 0, 0);
      }
    },
  };
}

/** Loads one encounter's spotanims the way the scene does and returns its renderer. */
export async function loadEncounterSpotAnims(
  pipeline: SpotAnimPipeline,
  encounter: SpotAnimDigestEncounter,
  loader: Loose,
): Promise<{ scene: Loose; renderer: Loose }> {
  const scene = pipeline.createScene(encounter);
  const renderer = scene.spotAnimRenderer;
  renderer.setAnimationSystem(pipeline.animation);
  await scene.loadSpotAnims(loader);
  return { scene, renderer };
}

async function main(): Promise<void> {
  // picogl's UMD build, reached through the encounter modules, expects a browser global.
  (globalThis as { self?: unknown }).self ??= globalThis;
  const root = rendererRootArgument();
  const { path: cachePath, sha256 } = await findTestCacheForGenerator();
  const pipeline = await loadSpotAnimPipeline(resolve(root), cachePath);
  const encounters = {} as EncounterSpotAnimDigests;
  for (const encounter of SPOTANIM_DIGEST_ENCOUNTERS) {
    const { scene, renderer } = await loadEncounterSpotAnims(pipeline, encounter, pipeline.createLoader());
    encounters[encounter] = digestSpotAnimRenderer(renderer, pipeline.perfFlags);
    scene.dispose();
  }
  writeGoldenFixture(fileURLToPath(new URL('./encounterSpotAnimDrawGoldens.json', import.meta.url)), {
    about:
      'SpotAnimRenderer digests recorded from the renderer at --renderer-root, per encounter and preloaded effect: ' +
      'the baked ' +
      'parts (render state, positions, colors, alphas, face bias, uvs, texture ids, transparent-sort input) and ' +
      'every frame drawn on the skip-sort and full-sort transparent paths (the same attributes plus the model ' +
      'matrix). Normals are excluded.',
    regenerate: regenerateCommand('src/render/scene/__tests__/encounterSpotAnimDraws.ts'),
    cache: { file: '.test-cache/disk.zip', sha256 },
    encounters,
  } satisfies SpotAnimDrawGoldenFile);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
