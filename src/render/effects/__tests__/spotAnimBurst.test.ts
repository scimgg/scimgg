import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EncounterVisualEvent } from '../../../core/events/encounterVisual';
import type { ReplayDisplayFrame } from '../../../core/ReplayRecorder';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { SolHereditEncounter } from '../../../encounters/solHeredit/SolHereditEncounter';
import { COLOSSEUM_SPOTANIMS, SOL_ACTOR_ID } from '../../../npcs/colosseum/constants';
import { openSpotAnimModelLoader } from '../../../rs/model/__tests__/encounterModelFixtures';
import { REAL_CACHE_TEST_TIMEOUT_MS, skipWithoutRealCache } from '../../../test/helpers/real-cache';
import { perfFlags } from '../../../util/PerfFlags';
import {
  isResidentMesh3DCommand,
  type Mesh3DCommand,
  type NpcMesh3DCommand,
  type RenderQueue,
} from '../../core/commands';
import { instanceAtlasBoundBytes } from '../../core/meshSource';
import { ReplayEffectIndex } from '../../core/replayEffectIndex';
import { createProjection3D } from '../../projections/Projection3D';
import { colosseumGraphicStyle } from '../../scene/ColosseumSceneCompositor';
import { type EncounterCueFrame, EncounterCuePlayer } from '../EncounterCuePlayer';
import { SpotAnimRenderer } from '../SpotAnimRenderer';
import type { SpotAnimTransform } from '../spotAnimTypes';
import { writeViewProjection } from '../spotAnimViewRejection';

/**
 * A ripple-sized burst of Sol's real ground effects, drawn frame by frame at 60 fps from emission to
 * expiry, live and in replay with a seek back. Pin every command field, array byte, model matrix,
 * command/array identity and frame state. A separate visible digest, free of object identity (no
 * command, array or mesh-source numbering), checks that omitting wholly zero-alpha parts changes no
 * remaining draw payload or frame state: the full-sort queues lose 6,173 live / 9,125 replay
 * zero-alpha commands and nothing else. Both digests hash each frame state's actor id,
 * `spotanim:<instance id>`, and a graphic's instance id is its cue id
 * (`cue-<eventId>-graphic-<ordinal>`), so renaming cues changes both. A replay seek back rebuilds
 * the cues, as the scene does on a discontinuity, so each later frame queues its draws in emission
 * order.
 */

const initialSkipSort = perfFlags.skipTransparentSort;
/** A live frame's actors when no NPC is shown: no cue's actor life ends. */
const NO_CUE_ACTORS = { npcs: [], currentTick: 0 } as const;
afterEach(() => {
  perfFlags.skipTransparentSort = initialSkipSort;
  vi.restoreAllMocks();
});

const CAMERA = {
  cameraX: 30 * 128,
  cameraY: -1400,
  cameraZ: 22 * 128,
  yawSin: 0.2,
  yawCos: Math.sqrt(0.96),
  pitchSin: 0.5,
  pitchCos: Math.sqrt(0.75),
};

/** 13 × 13 tiles rippling out two cycles per ring, plus Sol's own telegraph and one on the player. */
function burst(eventId: number, tick: number): EncounterVisualEvent {
  const graphics: EncounterVisualEvent['graphics'][number][] = [];
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      graphics.push({
        spotAnimId: COLOSSEUM_SPOTANIMS.solMelee[graphics.length % 3],
        target: { kind: 'tile', position: [30 + dx, 30 + dy] },
        delayCycles: 2 * Math.max(Math.abs(dx), Math.abs(dy)),
        height: dx === 0 && dy === 0 ? 40 : 0,
      });
    }
  }
  graphics.push({
    spotAnimId: COLOSSEUM_SPOTANIMS.tripleTelegraphShort,
    target: { kind: 'attached', actorId: SOL_ACTOR_ID },
    delayCycles: 3,
    height: 0,
  });
  graphics.push({
    spotAnimId: COLOSSEUM_SPOTANIMS.totemImpact,
    target: { kind: 'attached', actorId: 'player' },
    delayCycles: 0,
    height: 64,
  });
  return { type: 'encounter_visual', eventId, tick, animations: [], projectiles: [], graphics };
}

/**
 * Sol walks and turns. The player leaves while each burst's graphic on them is playing, so it
 * detaches mid-effect, and comes back elsewhere, facing another way, before the effect ends.
 */
const PLAYER_ABSENT: readonly (readonly [number, number])[] = [
  [38, 44],
  [66, 72],
];
function actorAt(cycle: number) {
  return (actorId: string): SpotAnimTransform | null => {
    if (actorId === SOL_ACTOR_ID) return { position: [30 + cycle / 40, 31, -0.25], yaw2048: (cycle * 7) % 2048 };
    if (actorId !== 'player') return null;
    const returns = PLAYER_ABSENT.filter(([, back]) => cycle >= back).length;
    if (PLAYER_ABSENT.some(([gone, back]) => cycle >= gone && cycle < back)) return null;
    return { position: [27.5 + returns * 3, 28.5 + cycle / 100, 0], yaw2048: returns * 512 };
  };
}

const terrainHeights = Array.from({ length: 64 }, (_, x) =>
  Int32Array.from({ length: 64 }, (_, y) => -((x * 37 + y * 11) % 90)),
);

/** The frame Sol's scene hands its cue player once every actor is drawn. */
function cueFrame(cycle: number): EncounterCueFrame {
  return { cycle, resolveActor: () => null, resolveAttachment: actorAt(cycle), terrainHeights };
}

class Digest {
  private readonly hash = createHash('sha256');
  private readonly visibleHash = createHash('sha256');
  private readonly identities = new Map<object, number>();
  private zeroAlphaMeshIds: Set<string> | undefined;
  commands = 0;
  zeroAlphaCommands = 0;

  identity(value: object | undefined): number {
    if (!value) return -1;
    let id = this.identities.get(value);
    if (id === undefined) {
      id = this.identities.size;
      this.identities.set(value, id);
    }
    return id;
  }

  bytes(array: ArrayBufferView | undefined): void {
    if (!array) {
      this.hash.update('-;');
      return;
    }
    this.hash.update(`${array.constructor.name}/${array.byteLength}/${this.identity(array)};`);
    this.hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }

  frame(renderer: SpotAnimRenderer, queue: RenderQueue): void {
    this.zeroAlphaMeshIds ??= new Set(
      [...renderer['meshCache'].values()]
        .flatMap((entry) => [...entry.static, ...entry.frames.flat()])
        .filter((part) => part.blend === 'normal' && part.perVertexAlphas?.every((alpha) => alpha === 0))
        .map((part) => part.meshId),
    );
    this.hash.update('|');
    this.visibleHash.update('|');
    for (const command of queue.commands) {
      if (command.kind !== 'mesh3d') continue;
      this.commands++;
      const resident = isResidentMesh3DCommand(command) ? command : undefined;
      const embedded = resident ? undefined : (command as NpcMesh3DCommand);
      const alphas = embedded?.perVertexAlphas;
      const zeroAlpha = this.zeroAlphaMeshIds.has(command.meshId.replace(/-sorted$/, ''));
      if (zeroAlpha) this.zeroAlphaCommands++;
      else {
        this.visibleHash.update(
          JSON.stringify([
            command.meshId,
            command.materialId,
            command.depth,
            command.blend,
            embedded?.animated,
            command.cullFace,
            command.zIndex,
            command.depthBias,
            resident ? [resident.meshSource.id, resident.meshSourcePart] : null,
          ]),
        );
        for (const array of [
          command.modelMatrix,
          embedded?.positions,
          embedded?.perVertexHslColors,
          alphas,
          embedded?.perVertexFaceBias,
        ]) {
          this.visibleHash.update(array ? `${array.constructor.name}/${array.byteLength};` : '-;');
          if (array) this.visibleHash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
        }
      }
      this.hash.update(
        JSON.stringify([
          this.identity(command),
          command.meshId,
          command.materialId,
          command.depth,
          command.blend,
          embedded?.animated,
          command.cullFace,
          command.zIndex,
          command.depthBias,
          resident ? [this.identity(resident.meshSource), resident.meshSourcePart] : null,
        ]),
      );
      this.bytes(command.modelMatrix);
      this.bytes(embedded?.positions);
      this.bytes(embedded?.perVertexHslColors);
      this.bytes(embedded?.perVertexAlphas);
      this.bytes(embedded?.perVertexFaceBias);
    }
    const states = JSON.stringify(
      renderer.getFrameStates().map((state) => [state.actorId, state.currentFrame, state.position]),
    );
    this.hash.update(states);
    this.visibleHash.update(states);
  }

  digest(): string {
    return this.hash.digest('hex').slice(0, 16);
  }

  visibleDigest(): string {
    return this.visibleHash.digest('hex').slice(0, 16);
  }
}

async function setUp() {
  const { loader } = await openSpotAnimModelLoader('pinned');
  const renderer = new SpotAnimRenderer();
  renderer.preload(loader, [
    ...COLOSSEUM_SPOTANIMS.solMelee,
    COLOSSEUM_SPOTANIMS.tripleTelegraphShort,
    COLOSSEUM_SPOTANIMS.totemImpact,
  ]);
  renderer.setSorterProjection(CAMERA);
  return { renderer, loader, controller: new EncounterCuePlayer(renderer, colosseumGraphicStyle) };
}

/** Draws one 60 fps frame at `cycle`, as the compositor does: cue player, then expiry, then the queue. */
function drawFrame(renderer: SpotAnimRenderer, digest: Digest, cycle: number): void {
  renderer.tick(Math.floor(cycle / 30), cycle / 30);
  const queue: RenderQueue = { replayPresentationReady: true, commands: [] };
  renderer.render(queue);
  digest.frame(renderer, queue);
}

const CYCLES = Array.from({ length: 2 * 100 }, (_, frame) => 25 + frame / 2);

describe.skipIf(skipWithoutRealCache('pinned'))('a ripple-sized spotanim burst', () => {
  it(
    'omits the real melee effects’ zero-alpha parts without dropping frames or opaque vertices',
    async () => {
      const { renderer, loader } = await setUp();
      for (const id of COLOSSEUM_SPOTANIMS.solMelee) {
        const animation = loader.loadAnimatedSpotAnim(id);
        const entry = renderer['meshCache'].get(id);
        if (!animation || !entry) expect.fail(`Expected baked effect ${id}`);
        expect(entry.frames).toHaveLength(animation.frames.length);
        expect(entry.frameLengths).toEqual(animation.frameLengths);
        const uploads = entry.source?.materialize() ?? expect.fail('Expected resident opaque source');
        for (let frame = 0; frame < 3; frame++) {
          expect(entry.frames[frame]).toHaveLength(1);
          const [opaque] = entry.frames[frame];
          expect(opaque.blend).toBeUndefined();
          expect(opaque.depth).toBe('readwrite');
          expect(opaque.transparentSort).toBeUndefined();
          const resident = opaque.resident ?? expect.fail('Expected resident opaque geometry');
          expect(resident.source).toBe(entry.source);
          const uploaded = uploads[resident.part];
          expect(uploaded.positions).toHaveLength(720 * 3);
          expect(uploaded.perVertexAlphas).toEqual(new Float32Array(720).fill(1));
        }
      }
    },
    REAL_CACHE_TEST_TIMEOUT_MS,
  );

  it.each([
    { skipSort: true, digest: 'e5a48c315365c4c8', visible: '2729bfc275131081' },
    { skipSort: false, digest: 'e9f2571888cde18c', visible: 'e6b4f386aa210e58' },
  ])(
    'queues the pinned commands live, skip-sort $skipSort',
    async ({ skipSort, digest: expected, visible }) => {
      perfFlags.skipTransparentSort = skipSort;
      const { renderer, controller } = await setUp();
      const digest = new Digest();
      controller.consumeEvents([burst(7, 1)], NO_CUE_ACTORS);
      const onPlayer = new Map<number, string>();
      for (const cycle of CYCLES) {
        controller.takeAnimations(cycle);
        controller.update(cueFrame(cycle));
        drawFrame(renderer, digest, cycle);
        for (const eventId of [7, 8]) {
          const shown = renderer['activeInstances'].has(`cue-${eventId}-graphic-170`);
          if (onPlayer.get(eventId)?.slice(-1) !== (shown ? '+' : '-'))
            onPlayer.set(eventId, `${onPlayer.get(eventId) ?? ''}${shown ? '+' : '-'}`);
        }
        // A second burst lands mid-ripple, on the same tiles, under new ids.
        if (cycle === 50) controller.consumeEvents([burst(8, 2)], NO_CUE_ACTORS);
      }
      expect(digest.commands).toBeGreaterThan(169 * 40);
      // Each graphic on the player shows, detaches, shows again where they came back, then expires.
      expect(Object.fromEntries(onPlayer)).toEqual({ 7: '-+-+-', 8: '-+-+-' });
      // Everything but Sol's longer telegraph has expired.
      expect([...renderer['activeInstances'].keys()]).toEqual(['cue-7-graphic-169', 'cue-8-graphic-169']);
      // Before omission: 21,088 skip-sort draws, or 27,261 full-sort draws including 6,173
      // wholly zero-alpha parts. The camera already rejected those parts on the skip path.
      expect(digest.commands).toBe(21088);
      expect(digest.zeroAlphaCommands).toBe(0);
      expect(digest.visibleDigest()).toBe(visible);
      expect(digest.digest()).toBe(expected);
    },
    REAL_CACHE_TEST_TIMEOUT_MS,
  );

  it.each([
    { skipSort: true, digest: 'efa6d619519d76da', visible: '0f66aa0285a02351' },
    { skipSort: false, digest: '9067a76d5985847e', visible: 'd8c034ce8f0a349a' },
  ])(
    'queues the pinned commands in replay, through a seek back, skip-sort $skipSort',
    async ({ skipSort, digest: expected, visible }) => {
      perfFlags.skipTransparentSort = skipSort;
      const { renderer, controller } = await setUp();
      const digest = new Digest();
      const state = new SimulationEngine({ encounter: new SolHereditEncounter(7), combatSeed: 1 }).getState();
      const frames: ReplayDisplayFrame[] = [0, 1, 2, 3, 4, 5].map((tick) => ({
        state: { ...state, currentTick: tick },
        events: tick === 1 ? [burst(7, 1)] : tick === 2 ? [burst(8, 2)] : [],
      }));
      const index = new ReplayEffectIndex(frames);
      const cycles = [...CYCLES.slice(0, 60), ...CYCLES.slice(20, 40), ...CYCLES.slice(40)];
      let previous: number | undefined;
      for (const cycle of cycles) {
        const destination = { cycle, throughFrameIndex: Math.min(5, Math.floor(cycle / 30)) };
        // The compositor takes what the history owes, rebuilding on the seek back, then places it.
        controller.syncReplay(index, destination, previous === undefined || cycle < previous);
        previous = cycle;
        controller.update(cueFrame(cycle));
        drawFrame(renderer, digest, cycle);
      }
      expect(digest.commands).toBeGreaterThan(169 * 40);
      // Before omission: 26,672 skip-sort draws, or 35,797 full-sort draws including 9,125
      // wholly zero-alpha parts.
      expect(digest.commands).toBe(26672);
      expect(digest.zeroAlphaCommands).toBe(0);
      expect(digest.visibleDigest()).toBe(visible);
      expect(digest.digest()).toBe(expected);
    },
    REAL_CACHE_TEST_TIMEOUT_MS,
  );
  it.each([
    { name: 'portrait', viewport: { width: 393, height: 852, dpr: 3 }, yaw: 0 },
    { name: 'short portrait, turned', viewport: { width: 393, height: 695, dpr: 3 }, yaw: 90 },
  ])(
    'leaves out only melee draws a $name camera provably cannot see, and changes nothing else',
    async ({ viewport, yaw }) => {
      perfFlags.skipTransparentSort = true;
      const full = await setUp();
      const culled = await setUp();
      // Sol's default camera on a phone, looking at the burst's center.
      const camera = createProjection3D(viewport, { pitch: (-181 * 360) / 2048, yaw, targetX: 30.5, targetY: 30.5 });
      const viewProjection = new Float64Array(16);
      writeViewProjection(camera, viewProjection);
      const positionsOf = (command: Mesh3DCommand): Float32Array =>
        isResidentMesh3DCommand(command)
          ? command.meshSource.materialize()[command.meshSourcePart].positions
          : (command as NpcMesh3DCommand).positions;
      /** Every vertex lies past one side plane (x < -w, x > w, y < -w, y > w): no viewport coverage. */
      const provablyUnseen = (command: Mesh3DCommand): boolean => {
        const positions = positionsOf(command);
        const m = command.modelMatrix;
        const v = viewProjection;
        const outside = [true, true, true, true];
        for (let i = 0; i + 2 < positions.length; i += 3) {
          const [px, py, pz] = [positions[i], positions[i + 1], positions[i + 2]];
          const wx = m[0] * px + m[4] * py + m[8] * pz + m[12];
          const wy = m[1] * px + m[5] * py + m[9] * pz + m[13];
          const wz = m[2] * px + m[6] * py + m[10] * pz + m[14];
          const x = v[0] * wx + v[4] * wy + v[8] * wz + v[12];
          const y = v[1] * wx + v[5] * wy + v[9] * wz + v[13];
          const w = v[3] * wx + v[7] * wy + v[11] * wz + v[15];
          outside[0] &&= x + w < 0;
          outside[1] &&= w - x < 0;
          outside[2] &&= y + w < 0;
          outside[3] &&= w - y < 0;
        }
        return positions.length >= 9 && outside.some(Boolean);
      };
      const signature = (command: Mesh3DCommand) =>
        JSON.stringify([
          command.meshId,
          command.blend,
          command.depth,
          command.cullFace,
          command.depthBias,
          Array.from(command.modelMatrix),
          isResidentMesh3DCommand(command) ? command.meshSourcePart : (command as NpcMesh3DCommand).positions.length,
        ]);
      full.controller.consumeEvents([burst(7, 1)], NO_CUE_ACTORS);
      culled.controller.consumeEvents([burst(7, 1)], NO_CUE_ACTORS);
      let kept = 0;
      let leftOut = 0;
      for (const cycle of CYCLES) {
        const queues = [full, culled].map(({ renderer, controller }) => {
          controller.takeAnimations(cycle);
          controller.update(cueFrame(cycle));
          renderer.tick(Math.floor(cycle / 30), cycle / 30);
          renderer.setViewRejection(renderer === culled.renderer ? camera : null);
          const queue: RenderQueue = { replayPresentationReady: true, commands: [] };
          renderer.render(queue);
          renderer.setViewRejection(null);
          return queue.commands.filter((command): command is Mesh3DCommand => command.kind === 'mesh3d');
        });
        const [all, drawn] = queues;
        // The drawn commands are the full frame's, in order, minus some it drops.
        let next = 0;
        for (const command of all) {
          if (next < drawn.length && signature(drawn[next]) === signature(command)) {
            next++;
            kept++;
            continue;
          }
          leftOut++;
          expect(command.meshId).toMatch(/^spotanim-(2669|2670|2671)-/);
          expect(provablyUnseen(command), `${command.meshId} at cycle ${cycle}`).toBe(true);
        }
        expect(next).toBe(drawn.length);
        // Live instances, frame sounds and render centers are untouched.
        expect([...culled.renderer['activeInstances'].keys()]).toEqual([...full.renderer['activeInstances'].keys()]);
        expect(JSON.stringify(culled.renderer.getFrameStates())).toBe(JSON.stringify(full.renderer.getFrameStates()));
      }
      // A meaningful share is left out; everything else is drawn exactly as the full render draws it.
      expect(leftOut).toBeGreaterThan(0.2 * (kept + leftOut));
      expect(kept).toBeGreaterThan(0);
    },
    REAL_CACHE_TEST_TIMEOUT_MS,
  );

  it(
    'points every melee draw at its own arrays in one instancing atlas, and changes nothing else',
    async () => {
      perfFlags.skipTransparentSort = true;
      const { renderer, controller } = await setUp();
      renderer.setBatchableSpotAnimFamilies([COLOSSEUM_SPOTANIMS.solMelee]);
      const digest = new Digest();
      controller.consumeEvents([burst(7, 1)], NO_CUE_ACTORS);
      const sources = new Set<object>();
      let atlasParts: ReturnType<NonNullable<Mesh3DCommand['instanceAtlas']>['materialize']> | undefined;
      const checked = new Set<number>();
      let melee = 0;
      for (const cycle of CYCLES) {
        controller.takeAnimations(cycle);
        controller.update(cueFrame(cycle));
        renderer.tick(Math.floor(cycle / 30), cycle / 30);
        const queue: RenderQueue = { replayPresentationReady: true, commands: [] };
        renderer.render(queue);
        digest.frame(renderer, queue);
        for (const command of queue.commands) {
          if (command.kind !== 'mesh3d') continue;
          const isMelee = /^spotanim-(2669|2670|2671)-/.test(command.meshId);
          expect(command.instanceAtlas !== undefined, command.meshId).toBe(isMelee);
          if (!command.instanceAtlas || command.instanceAtlasPart === undefined) continue;
          melee++;
          sources.add(command.instanceAtlas);
          atlasParts ??= command.instanceAtlas.materialize();
          if (checked.has(command.instanceAtlasPart)) continue;
          checked.add(command.instanceAtlasPart);
          // The atlas part holds exactly the arrays the command draws by itself.
          const own = isResidentMesh3DCommand(command)
            ? command.meshSource.materialize()[command.meshSourcePart]
            : (command as NpcMesh3DCommand);
          const part = atlasParts[command.instanceAtlasPart];
          expect(part?.positions).toEqual(own?.positions);
          expect(part?.perVertexHslColors).toEqual(own?.perVertexHslColors);
          expect(part?.perVertexAlphas).toEqual(own?.perVertexAlphas);
          expect(part?.perVertexFaceBias).toEqual(own?.perVertexFaceBias);
        }
        // As the pinned run: a second burst lands mid-ripple.
        if (cycle === 50) controller.consumeEvents([burst(8, 2)], NO_CUE_ACTORS);
      }
      // One atlas for the whole burst: 3 variants × 10 frames, one part each, every one drawn.
      expect(sources.size).toBe(1);
      expect(atlasParts).toHaveLength(30);
      expect(checked.size).toBe(30);
      expect(melee).toBeGreaterThan(169 * 40);
      // The commands are the pinned skip-sort ones: the atlas is carried beside them, not instead.
      expect(digest.commands).toBe(21088);
      expect(digest.visibleDigest()).toBe('2729bfc275131081');
      expect(digest.digest()).toBe('e5a48c315365c4c8');

      // Opting out again drops it from the next frame's draws, and retires it.
      renderer.setBatchableSpotAnimFamilies([]);
      for (const source of sources) expect((source as { retired: boolean }).retired).toBe(true);
      const queue: RenderQueue = { replayPresentationReady: true, commands: [] };
      controller.consumeEvents([burst(9, 10)], NO_CUE_ACTORS);
      controller.update(cueFrame(300));
      renderer.tick(10, 10);
      renderer.render(queue);
      expect(queue.commands.length).toBeGreaterThan(0);
      expect(queue.commands.some((command) => command.kind === 'mesh3d' && command.instanceAtlas)).toBe(false);
    },
    REAL_CACHE_TEST_TIMEOUT_MS,
  );
});

describe.skipIf(skipWithoutRealCache('pinned'))('Sol crystal beams', () => {
  const BEAMS: readonly number[] = [
    ...COLOSSEUM_SPOTANIMS.crystalCharge,
    ...COLOSSEUM_SPOTANIMS.crystalFire,
    COLOSSEUM_SPOTANIMS.crystalImpact,
  ];

  /** Each beam's certified parts, as `<blend> <frames>` where they are certified, from the real cache. */
  function certified(renderer: SpotAnimRenderer, id: number): string[] {
    const entry = renderer['meshCache'].get(id) ?? expect.fail(`Expected baked effect ${id}`);
    const frames = new Map<string, number[]>();
    for (const [frame, parts] of entry.frames.entries()) {
      for (const part of parts) {
        if (!part.hasOnlyRepeatedCornerTriangles) continue;
        const blend = part.blend ?? 'opaque';
        frames.set(blend, [...(frames.get(blend) ?? []), frame]);
      }
    }
    return [...frames].map(([blend, list]) => `${blend} ${list.join(',')}`);
  }

  it(
    'builds no atlas for the beams, whose bound is over the allowance, and draws them as before',
    async () => {
      const { loader } = await openSpotAnimModelLoader('pinned');
      const renderer = new SpotAnimRenderer();
      renderer.preload(loader, [...COLOSSEUM_SPOTANIMS.solMelee, ...BEAMS]);
      renderer.setSorterProjection(CAMERA);
      const bake = vi.spyOn(loader, 'loadAnimatedSpotAnim');
      renderer.setBatchableSpotAnimFamilies([COLOSSEUM_SPOTANIMS.solMelee, BEAMS]);
      // Melee first, under 1 MiB; the beams' bound (from their bakes' part sizes) alone is ~64 MiB.
      const bound = (ids: readonly number[]) =>
        instanceAtlasBoundBytes(
          ids.flatMap((id) =>
            (renderer['meshCache'].get(id)?.frames ?? [])
              .flat()
              .map((part) =>
                part.resident
                  ? (part.resident.source.parts[part.resident.part]?.vertexCount ?? 0)
                  : (part.positions?.length ?? 0) / 3,
              ),
          ),
        );
      expect([bound(COLOSSEUM_SPOTANIMS.solMelee), bound(BEAMS)]).toEqual([821_448, 67_612_920]);
      // Only the melee atlas's recipe ran: nothing was baked again to reject the beams.
      expect(new Set(bake.mock.calls.map(([id]) => id))).toEqual(new Set(COLOSSEUM_SPOTANIMS.solMelee));
      expect(
        renderer
          .getResidentMeshSources()
          .filter((source) => source.use === 'instanceAtlas')
          .map((source) => source.id),
      ).toEqual(['spotanim-atlas-2669-2670-2671']);
      for (const id of BEAMS) {
        renderer.clearActiveInstances();
        renderer.upsert({
          instanceId: `beam-${id}`,
          spotAnimId: id,
          lifecycle: { kind: 'manual' },
          transform: { kind: 'static', value: { position: [3, 3, 0] } },
          frameProgress: 0.1,
        });
        const queue: RenderQueue = { replayPresentationReady: true, commands: [] };
        renderer.render(queue);
        expect(queue.commands.length, `${id}`).toBeGreaterThan(0);
        expect(queue.commands.some((command) => command.kind === 'mesh3d' && command.instanceAtlas)).toBe(false);
      }
    },
    REAL_CACHE_TEST_TIMEOUT_MS,
  );

  it.each([true, false])(
    'certifies the beam parts that have collapsed, and leaves exactly those out where asked, skip-sort %s',
    async (skipSort) => {
      perfFlags.skipTransparentSort = skipSort;
      const { loader } = await openSpotAnimModelLoader('pinned');
      const full = new SpotAnimRenderer();
      const skipping = new SpotAnimRenderer();
      for (const renderer of [full, skipping]) {
        renderer.preload(loader, [...BEAMS]);
        renderer.setSorterProjection(CAMERA);
      }
      skipping.setZeroAreaPartSkip(BEAMS);
      // The charge lines' transparent parts collapse from frame 3 (of 43), the fire lines' opaque
      // parts over frames 6 to 26 (of 27); the impact never does. Every frame keeps its other part.
      const frames = (first: number, last: number) =>
        Array.from({ length: last - first + 1 }, (_, index) => first + index).join(',');
      const chargeFrames = `normal ${frames(3, 42)}`;
      const fireFrames = `opaque ${frames(6, 26)}`;
      expect(Object.fromEntries(BEAMS.map((id) => [id, certified(full, id)]))).toEqual({
        2689: [chargeFrames],
        2690: [chargeFrames],
        2691: [chargeFrames],
        2692: [chargeFrames],
        2693: [fireFrames],
        2694: [fireFrames],
        2695: [fireFrames],
        2696: [fireFrames],
        2697: [],
      });
      const leftOut = new Set<string>();
      const certifiedIds = new Set<string>();
      for (const id of BEAMS) {
        full['meshCache'].get(id)?.frames.forEach((parts, frame) => {
          for (const part of parts)
            if (part.hasOnlyRepeatedCornerTriangles)
              certifiedIds.add(`spotanim-${id}-frame-${frame}-${part.blend ? 'transparent' : 'opaque'}`);
        });
        // Enough samples to show every frame of the longest (43-frame) beam.
        for (let sample = 0; sample < 200; sample++) {
          const drawn = [full, skipping].map((renderer) => {
            renderer.clearActiveInstances();
            renderer.upsert({
              instanceId: 'beam',
              spotAnimId: id,
              lifecycle: { kind: 'manual' },
              transform: { kind: 'static', value: { position: [3, 3, 0] } },
              frameProgress: (sample + 0.5) / 200,
            });
            const queue: RenderQueue = { replayPresentationReady: true, commands: [] };
            renderer.render(queue);
            return queue.commands.filter((command): command is Mesh3DCommand => command.kind === 'mesh3d');
          });
          const [all, kept] = drawn as [Mesh3DCommand[], Mesh3DCommand[]];
          // Of the full frame's draws, in order, the skipping one leaves out exactly the certified parts.
          // A fully sorted part draws as `<part>-sorted`.
          const partOf = (command: Mesh3DCommand) => command.meshId.replace(/-sorted$/, '');
          const expected = all.filter((command) => !certifiedIds.has(partOf(command)));
          expect(kept.map((command) => command.meshId)).toEqual(expected.map((command) => command.meshId));
          for (const [index, command] of kept.entries())
            expect(command.modelMatrix).toEqual(expected[index]?.modelMatrix);
          const keptIds = new Set(kept.map((command) => command.meshId));
          for (const command of all) if (!keptIds.has(command.meshId)) leftOut.add(partOf(command));
        }
      }
      expect(certifiedIds.size).toBe(4 * 40 + 4 * 21);
      // Every certified part the full renderer draws is left out by the other. Skipping the sort, the
      // CPU back-face test already drops the collapsed transparent ones (no face of zero area faces the
      // camera), so there only the fire lines' opaque parts go; sorted, the transparent ones go too.
      expect([...leftOut].sort()).toEqual(
        [...certifiedIds].filter((meshId) => !skipSort || meshId.endsWith('-opaque')).sort(),
      );
    },
    REAL_CACHE_TEST_TIMEOUT_MS,
  );
});
