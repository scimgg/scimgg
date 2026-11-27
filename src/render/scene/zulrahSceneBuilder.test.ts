import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayDisplayFrame } from '../../core/ReplayRecorder';
import { SimulationEngine } from '../../core/SimulationEngine';
import { ZULRAH_RENDER_CONFIG } from '../../encounters/zulrah/renderConfig';
import { ZulrahEncounter } from '../../encounters/zulrah/ZulrahEncounter';
import {
  ZULRAH_MAGIC_NPC_ID,
  ZULRAH_MELEE_NPC_ID,
  ZULRAH_RANGED_NPC_ID,
  ZULRAH_SEQS,
  ZULRAH_SIZE,
} from '../../npcs/zulrah/constants';
import { NpcType } from '../../rs/config/npctype/NpcType';
import { SeqType } from '../../rs/config/seqtype/SeqType';
import { ModelData } from '../../rs/model/ModelData';
import { NpcModelLoader } from '../../rs/model/NpcModelLoader';
import type { NpcState } from '../../types/simulation';
import { AnimationSystem } from '../backends/picogl/AnimationSystem';
import type { Projection2D } from '../core/camera';
import { makeSnapshot } from '../npc/__tests__/npcFacingTestHarness';
import { InfernoSceneCompositor } from './InfernoSceneCompositor';
import type { RenderContext } from './types';
import { createZulrahSceneBuilder } from './zulrahSceneBuilder';

const cacheInfo = {
  name: 'test',
  game: 'oldschool',
  environment: 'live',
  revision: 242,
  timestamp: '',
  size: 0,
} as const;
const ZULRAH_FORMS = [ZULRAH_RANGED_NPC_ID, ZULRAH_MELEE_NPC_ID, ZULRAH_MAGIC_NPC_ID] as const;

/** One-triangle models and 3-frame clips; the death clip lasts 60 cycles (1.2 s), longer than a tick. */
function assets() {
  const loader = new NpcModelLoader(
    {
      load: (id) => {
        const type = new NpcType(id, cacheInfo);
        type.modelIds = [id];
        type.size = (ZULRAH_FORMS as readonly number[]).includes(id) ? ZULRAH_SIZE : 1;
        return type;
      },
      getCount: () => 1,
      clearCache: () => {},
    },
    {
      getModel: () => {
        const model = new ModelData();
        model.verticesCount = 3;
        model.usedVertexCount = 3;
        model.verticesX = new Int32Array([0, 128, 0]);
        model.verticesY = new Int32Array([0, 0, -128]);
        model.verticesZ = new Int32Array([0, 0, 128]);
        model.faceCount = 1;
        model.indices1 = new Int32Array([0]);
        model.indices2 = new Int32Array([1]);
        model.indices3 = new Int32Array([2]);
        model.faceColors = new Uint16Array([100]);
        return model;
      },
    },
  );
  const animation = new AnimationSystem();
  vi.spyOn(animation, 'isInitialized').mockReturnValue(true);
  vi.spyOn(animation, 'loadSeqType').mockImplementation((id) => {
    const sequence = new SeqType(id, cacheInfo);
    sequence.frameIds = [10, 11, 12];
    sequence.frameLengths = id === ZULRAH_SEQS.death ? [20, 20, 20] : [2, 3, 5];
    return sequence;
  });
  return { loader, animation };
}

afterEach(() => vi.restoreAllMocks());

async function zulrahScene() {
  const scene = createZulrahSceneBuilder();
  if (!(scene instanceof InfernoSceneCompositor)) expect.fail('Expected the Inferno compositor');
  const { loader, animation } = assets();
  await scene.loadNpc(loader, animation);
  // A replay seek waits for the encounter's graphics; these tests draw none.
  vi.spyOn(scene['spotAnimRenderer'], 'isLoaded').mockReturnValue(true);
  const state = new SimulationEngine({ encounter: new ZulrahEncounter(1), combatSeed: 1 }).getState();
  const projection: Projection2D = {
    tileToScreen: (tile) => tile,
    tileDeltaToScreen: (tile) => tile,
    screenToTile: () => null,
    tilePolygonScreen: (tile) => [tile, tile, tile, tile],
  };
  const draw = (cycle: number, npcs: NpcState[], overrides: Partial<RenderContext> = {}) =>
    scene.build(
      {
        simulationState: { ...state, currentTick: Math.floor(cycle / 30), npcs },
        interpolatedTick: cycle / 30,
        speedMultiplier: 1,
        interaction: { hoveredTile: null, targetTile: null },
        timeline: { timelineKey: 'live', paused: false },
        events: [],
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
        ...overrides,
      },
      projection,
      { width: 800, height: 600, dpr: 1 },
    );
  const manager = scene['npcInstanceManager'];
  const pose = (actorId: string) =>
    (
      manager['instanceRegistry'].get(actorId) ?? manager['dyingInstances'].get(actorId)?.instance
    )?.animController?.getFrameState();
  return { scene, manager, state, draw, pose };
}

const zulrah = (npcTypeId: number, overrides: Partial<NpcState> = {}): NpcState => ({
  ...makeSnapshot({ id: 'zulrah', npcTypeId, position: [26, 65], size: ZULRAH_SIZE, role: 'boss' }),
  history: new Map(),
  spawnTick: 0,
  ...overrides,
});

describe('Zulrah scene: the boss death clip', () => {
  it('opts each form into the boss death clip, for the clip its own length', () => {
    for (const npcTypeId of ZULRAH_FORMS) {
      const type = ZULRAH_RENDER_CONFIG.preloadNpcTypes?.find((t) => t.npcTypeId === npcTypeId);
      expect(type).toMatchObject({ deathSeqId: ZULRAH_SEQS.death, bossDeathAnimationEnabled: true });
      expect(type).not.toHaveProperty('deathDurationMs');
    }
  });

  it.each(ZULRAH_FORMS)('plays SNAKEBOSS_DEATH when form %i is killed live', async (npcTypeId) => {
    const live = await zulrahScene();
    const alive = zulrah(npcTypeId);
    live.draw(30, [alive]);
    live.draw(59, [alive]);
    live.draw(60, [{ ...alive, alive: false, hp: 0, despawnTick: 2 }]);
    expect(live.manager.getDyingActorIds().has('zulrah')).toBe(true);
    expect(live.pose('zulrah')?.seqId).toBe(ZULRAH_SEQS.death);
    live.scene.dispose();
  });

  it('rebuilds the death clip at its age on a seek into the death', async () => {
    const seek = await zulrahScene();
    // Killed on tick 2; the seek lands on tick 3, one tick (600 ms) into the 1.2 s clip.
    const alive = zulrah(ZULRAH_MAGIC_NPC_ID);
    const dead = { ...alive, alive: false, hp: 0, despawnTick: 2 };
    const frames: ReplayDisplayFrame[] = [0, 1, 2, 3].map((tick) => ({
      state: { ...seek.state, currentTick: tick, npcs: [tick < 2 ? alive : dead] },
      events: [],
    }));
    seek.draw(90, [dead], {
      simulationState: frames[3]!.state,
      replayHistory: { frames, throughFrameIndex: 3 },
      timeline: { timelineKey: 'replay', paused: true, timeMs: 3 * 600 },
    });
    expect(seek.manager['dyingInstances'].get('zulrah')?.deathTimerMs).toBeCloseTo(600);
    expect(seek.pose('zulrah')).toMatchObject({ seqId: ZULRAH_SEQS.death, currentFrameIndex: 1 });
    seek.scene.dispose();
  });
});
