import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../audio/AudioEngine';
import { EventAudioPlayer } from '../../audio/EventAudioPlayer';
import { FrameSoundTracker } from '../../audio/FrameSoundTracker';
import { setArenaConfig, setDefaultArenaConfig } from '../../core/constants';
import { type EncounterVisualEvent, isEncounterVisualEvent } from '../../core/events/encounterVisual';
import type { GameEvent } from '../../core/events/types';
import { type ReplayDisplayFrame, ReplayRecorder, type ReplayRecorderData } from '../../core/ReplayRecorder';
import { ReplayFrameStore } from '../../core/replayFrameStore';
import { MAX_REPLAY_PROJECTILE_STEPS, ReplaySafetyError } from '../../core/replaySafety';
import { SimulationEngine } from '../../core/SimulationEngine';
import { INFERNO_RENDER_CONFIG } from '../../encounters/inferno/renderConfig';
import { reconstructReplayPrefix } from '../../encounters/simulationEngineFactory';
import { YAMA_ENCOUNTER_RENDER_CONFIG } from '../../encounters/yamaP3/renderConfig';
import { ZUK_INTRO_RISE_CLIP, ZUK_MAP_SQUARE, ZUK_MAP_SQUARE_OFFSETS } from '../../encounters/zuk/constants';
import { ZUK_WAVE_NPC_TYPES } from '../../encounters/zuk/renderConfig';
import {
  INFERNO_SPOT_ANIM_IDS,
  INFERNO_WAVE_NPC_IDS,
  INFERNO_WAVE_SEQS,
  INFERNO_WAVE_SPOT_ANIM_IDS,
  ZUK_ACTOR_ID,
  ZUK_NPC_ID,
  ZUK_SEQS,
  ZUK_SHIELD_NPC_ID,
} from '../../npcs/inferno/constants';
import { NpcType } from '../../rs/config/npctype/NpcType';
import { SeqType } from '../../rs/config/seqtype/SeqType';
import { ModelData } from '../../rs/model/ModelData';
import { NpcModelLoader } from '../../rs/model/NpcModelLoader';
import { rgbToHsl } from '../../rs/util/ColorUtil';
import { zukSnapshot } from '../../test/helpers/encounterSnapshot';
import { LEGACY_INFERNO, legacyInfernoRecording } from '../../test/helpers/legacyEncounterRecordings';
import {
  activeWindows,
  IDENTITY_PROJECTION,
  installSyntheticSpotAnims,
  observeScene,
  replayContextAt,
  SCENE_OPTIONS,
  type SceneObservation,
  SYNTHETIC_CLIP_FRAME_CYCLES,
  syntheticNpcAssets,
  VIEWPORT,
} from '../../test/helpers/sceneObservation';
import { createZukWaveEncounter } from '../../test/helpers/zukWave';
import type { RestoredPresentation } from '../../types/restoredPresentation';
import type { NpcSnapshot, NpcState, SimulationState } from '../../types/simulation';
import { AnimationSystem } from '../backends/picogl/AnimationSystem';
import type { Projection2D } from '../core/camera';
import type { RenderQueue } from '../core/commands';
import { EncounterCuePlayer } from '../effects/EncounterCuePlayer';
import { advanceProjectileMotion } from '../effects/projectileMotion';
import { makeSnapshot } from '../npc/__tests__/npcFacingTestHarness';
import { NpcAnimationController } from '../npc/NpcAnimationController';
import { PRIMARY_NPC_ACTOR_ID } from '../npc/NpcInstanceManager';
import { type EncounterRenderConfig, getEncounterRenderConfig } from './encounterRenderConfig';
import { InfernoSceneCompositor } from './InfernoSceneCompositor';
import { SceneCompositor, Z_LAYERS } from './SceneCompositor';
import type { RenderContext } from './types';
import { createZukSceneBuilder } from './zukSceneBuilder';

const cacheInfo = {
  name: 'test',
  game: 'oldschool',
  environment: 'live',
  revision: 232,
  timestamp: '',
  size: 0,
} as const;

/**
 * TzKal-Zuk drawn as a primary NPC, as he was while he had his own kind: the compositor's
 * primary-NPC path these suites exercise. The shipped Inferno config draws him as an ordinary
 * instance instead (`INFERNO_RENDER_CONFIG`, covered below).
 */
const ZUK_PRIMARY_RENDER_CONFIG: EncounterRenderConfig = {
  terrainMapSquare: ZUK_MAP_SQUARE,
  mapSquareOffsets: ZUK_MAP_SQUARE_OFFSETS,
  primaryNpc: {
    actorId: ZUK_ACTOR_ID,
    npcTypeId: ZUK_NPC_ID,
    basePosition: [28, 52],
    size: 7,
    deathSeqId: ZUK_SEQS.zuk.death,
  },
  spotAnimIds: INFERNO_SPOT_ANIM_IDS,
  preloadNpcTypes: ZUK_WAVE_NPC_TYPES.map(({ bossDeathAnimationEnabled: _opt, deathSeqId, ...type }) =>
    type.npcTypeId === ZUK_NPC_ID ? type : { ...type, ...(deathSeqId === undefined ? {} : { deathSeqId }) },
  ),
};

class SceneProbe extends InfernoSceneCompositor {
  readonly manager = this.npcInstanceManager;
  readonly effects = this.spotAnimRenderer;
  events(events: EncounterVisualEvent[]): void {
    this.cues.consumeEvents(events);
  }
  sync(npcs: NpcSnapshot[]): void {
    this.syncNpcInstances(npcs, false);
  }
  animate(state: Pick<SimulationState, 'currentTick' | 'npcs'>, tick: number): void {
    this.getEncounterAttackTriggers(state, tick);
  }
}

function assets() {
  const loader = new NpcModelLoader(
    {
      load: (id) => {
        const type = new NpcType(id, cacheInfo);
        type.modelIds = [id];
        type.size = id === ZUK_NPC_ID ? 7 : 1;
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
  const loadSequence = vi.spyOn(animation, 'loadSeqType').mockImplementation((id) => {
    const sequence = new SeqType(id, cacheInfo);
    sequence.frameIds = [10, 11, 12];
    sequence.frameLengths = [2, 3, 5];
    return sequence;
  });
  return { loader, animation, loadSequence };
}

afterEach(() => {
  vi.restoreAllMocks();
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
});

async function frameAudio() {
  const audio = new AudioEngine();
  const play = vi.spyOn(audio, 'play').mockImplementation(() => {});
  const tracker = new FrameSoundTracker(audio);
  const update = vi.spyOn(tracker, 'update');
  const silentSync = vi.spyOn(tracker, 'silentSync');
  const reset = vi.spyOn(tracker, 'reset');
  const scene = createZukSceneBuilder({ frameSoundTracker: tracker, encounterRenderConfig: ZUK_PRIMARY_RENDER_CONFIG });
  if (!(scene instanceof InfernoSceneCompositor)) expect.fail('Expected Inferno compositor');
  const { loader, animation, loadSequence } = assets();
  const sequence = loadSequence(ZUK_SEQS.zuk.attack);
  if (!sequence) expect.fail('Expected attack sequence');
  sequence.frameSounds = new Map(
    [0, 1, 2].map((frame) => [frame, [{ id: 9000 + frame, loops: 1, location: 0, retain: 0 }]]),
  );
  const idle = new SeqType(ZUK_SEQS.zuk.idle, cacheInfo);
  idle.frameIds = [10];
  idle.frameLengths = [30];
  loadSequence.mockImplementation((id) => (id === sequence.id ? sequence : idle));
  await scene.loadNpc(loader, animation);
  loadEffectFixtures(scene);
  const engine = new SimulationEngine({ encounter: createZukWaveEncounter(1), combatSeed: 1 });
  const state = engine.getState();
  const projection: Projection2D = {
    tileToScreen: (tile) => tile,
    tileDeltaToScreen: (tile) => tile,
    screenToTile: () => null,
    tilePolygonScreen: (tile) => [
      tile,
      { x: tile.x + 1, y: tile.y },
      { x: tile.x + 1, y: tile.y + 1 },
      { x: tile.x, y: tile.y + 1 },
    ],
  };
  const draw = (cycle: number, overrides: Partial<RenderContext> = {}) =>
    scene.build(
      {
        simulationState: { ...state, currentTick: Math.floor(cycle / 30) },
        interpolatedTick: cycle / 30,
        speedMultiplier: 1,
        interaction: { hoveredTile: null, targetTile: null },
        timeline: { timelineKey: 'live', paused: false },
        events: [
          {
            type: 'encounter_visual',
            eventId: 1,
            tick: 0,
            projectiles: [],
            graphics: [],
            animations: [{ actorId: ZUK_ACTOR_ID, clipId: 'attack', delayCycles: 0 }],
          },
        ],
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
  return { scene, tracker, play, update, silentSync, reset, draw, state, engine };
}

function loadEffectFixtures(
  scene: InfernoSceneCompositor,
  spotAnimIds: readonly number[] = INFERNO_SPOT_ANIM_IDS,
): void {
  for (const spotAnimId of spotAnimIds)
    scene['spotAnimRenderer']['meshCache'].set(spotAnimId, {
      static: [
        {
          meshId: `effect-${spotAnimId}`,
          materialId: 'osrs-npc',
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
          depth: 'readwrite',
        },
      ],
      frames: [],
      frameLengths: [60],
      frameStep: -1,
      heightOffset: 0,
    });
}

function safeScene(renderMode: '2d' | '3d') {
  const scene = new SceneProbe();
  scene.setEncounterRenderConfig(ZUK_PRIMARY_RENDER_CONFIG);
  scene['terrainHeights'] = Array.from({ length: 65 }, (_, x) =>
    Int32Array.from({ length: 65 }, (_, y) => -(x + y) * 128),
  );
  const initial = new SimulationEngine({ encounter: createZukWaveEncounter(1), combatSeed: 1 }).getState();
  const state: SimulationState = {
    ...initial,
    mechanicsConfig: { ...initial.mechanicsConfig, zukShieldSafeTiles: true },
    encounter: zukSnapshot({ shieldX: 30, shieldNextX: 30, shieldMovingEast: true }),
    npcs: initial.npcs.map((npc) =>
      npc.archetypeId === 'zuk_shield' ? { ...npc, position: [30, 47], previousPosition: [29, 47] } : npc,
    ),
  };
  const walkableTiles = new Set([
    '28,44',
    '29,44',
    '30,43',
    '30,44',
    '33,44',
    '34,44',
    '30,48',
    '35,49',
    '27,44',
    '36,44',
    '28,42',
    '28,50',
  ]);
  const bounds = { minX: 28, maxX: 35, minY: 43, maxY: 49, width: 8, height: 7 };
  setArenaConfig({ bounds, walkableTiles, collisionMap: null }, true);
  const context: RenderContext = {
    simulationState: state,
    events: [],
    interpolatedTick: 0.5,
    speedMultiplier: 1,
    interaction: { hoveredTile: null, targetTile: [34, 44] },
    options: {
      renderMode,
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
    tileDeltaToScreen: (tile) => tile,
    screenToTile: () => null,
    tilePolygonScreen: (tile) => [
      tile,
      { x: tile.x + 1, y: tile.y },
      { x: tile.x + 1, y: tile.y + 1 },
      { x: tile.x, y: tile.y + 1 },
    ],
  };
  const draw = (overrides: Partial<RenderContext> = {}) =>
    scene.build({ ...context, ...overrides }, projection, { width: 800, height: 600, dpr: 1 });
  return { scene, state, context, bounds, walkableTiles, projection, draw };
}

it.each([
  { renderMode: '2d', ready: true },
  { renderMode: '3d', ready: false },
] as const)('reports replay readiness $ready when a fresh $renderMode scene has no 3D assets', ({
  renderMode,
  ready,
}) => {
  const { scene, state, draw } = safeScene(renderMode);
  const frames: readonly ReplayDisplayFrame[] = [{ state, events: [] }];
  const store = new ReplayFrameStore();
  const unregister = store.registerRenderConsumer();
  store.setHistory(frames);

  try {
    const queue = draw({
      replayHistory: { frames, throughFrameIndex: 0 },
      timeline: { timelineKey: 'replay', paused: false, timeMs: 0 },
    });
    if (queue.replayPresentationReady) store.acknowledgeRender(store.getRenderEpoch(), 0, 0);

    expect(queue.replayPresentationReady).toBe(ready);
    expect(store.isFrameRendered(0)).toBe(ready);
  } finally {
    unregister();
    scene.dispose();
  }
});

it('passes the build allowance through both Inferno and player controller updates', () => {
  const { scene, state, draw } = safeScene('3d');
  vi.spyOn(scene['cues'], 'update').mockImplementation((_frame, work) => {
    if (!work) expect.fail('Missing explicit Inferno projectile allowance');
    work.charge(1);
  });
  vi.spyOn(scene['projectileController'], 'update').mockImplementation(
    (_renderer, _tick, _interpolatedTick, _loader, _facing, _resolver, work) => {
      if (!work) expect.fail('Missing explicit player projectile allowance');
      work.charge(MAX_REPLAY_PROJECTILE_STEPS);
    },
  );
  try {
    expect(() => draw({ replayHistory: { frames: [{ state, events: [] }], throughFrameIndex: 0 } })).toThrowError(
      new ReplaySafetyError('projectile-work-limit', {
        actual: MAX_REPLAY_PROJECTILE_STEPS + 1,
        limit: MAX_REPLAY_PROJECTILE_STEPS,
      }),
    );
    expect(scene['replayProjectileWork']).toBeUndefined();
  } finally {
    scene.dispose();
  }
});

function safeEdges(queue: RenderQueue): number[][] {
  const halfEdges = new Map<string, number>();
  const edges = queue.commands
    .filter((command) => command.zIndex === Z_LAYERS.GRID + 2)
    .flatMap((command) => {
      if (command.kind === 'poly2d') {
        expect(command.fill).toBeUndefined();
        expect(command.closePath).toBe(false);
        expect(command.points).toHaveLength(3);
        const [start, center, end] = command.points;
        for (const midpoint of [start, end]) {
          const neighbor = { x: 2 * midpoint.x - center.x, y: 2 * midpoint.y - center.y };
          const key = [
            Math.min(center.x, neighbor.x),
            Math.min(center.y, neighbor.y),
            Math.max(center.x, neighbor.x),
            Math.max(center.y, neighbor.y),
          ].join(',');
          halfEdges.set(key, (halfEdges.get(key) ?? 0) + 1);
        }
        return [];
      }
      if (command.kind === 'mesh3d' && 'positions' in command && command.positions instanceof Float32Array) {
        if (command.meshId.startsWith('edge-join-')) return [];
        const p = command.positions;
        expect(p).toHaveLength(18);
        return [[(p[0] + p[15]) / 2, (p[1] + p[16]) / 2, (p[3] + p[6]) / 2, (p[4] + p[7]) / 2]];
      }
      return expect.fail('Expected safe region edge geometry');
    });
  for (const [key, count] of halfEdges) {
    expect(count).toBe(2);
    edges.push(key.split(',').map(Number));
  }
  return edges;
}

function coverageAt(queue: RenderQueue, point: readonly [number, number]): number {
  let coverage = 0;
  for (const command of queue.commands) {
    if (
      command.zIndex !== Z_LAYERS.GRID + 2 ||
      command.kind !== 'mesh3d' ||
      !('positions' in command) ||
      !(command.positions instanceof Float32Array)
    )
      continue;
    const positions = command.positions;
    for (let index = 0; index < positions.length; index += 9) {
      const sides = [0, 3, 6].map((offset, vertex) => {
        const next = ((vertex + 1) % 3) * 3;
        return (
          (positions[index + next] - positions[index + offset]) * (point[1] - positions[index + offset + 1]) -
          (positions[index + next + 1] - positions[index + offset + 1]) * (point[0] - positions[index + offset])
        );
      });
      if (sides.every((side) => side > 0) || sides.every((side) => side < 0)) coverage++;
    }
  }
  return coverage;
}

function expectSafeBoundary(queue: RenderQueue, tiles: number[][]): void {
  const edges = new Set<string>();
  for (const [x, y] of tiles) {
    for (const edge of [
      [x, y, x + 1, y],
      [x + 1, y, x + 1, y + 1],
      [x, y + 1, x + 1, y + 1],
      [x, y, x, y + 1],
    ]) {
      const key = edge.join(',');
      if (edges.has(key)) edges.delete(key);
      else edges.add(key);
    }
  }
  expect(
    safeEdges(queue)
      .map((edge) => edge.join(','))
      .sort(),
  ).toEqual([...edges].sort());
  const fills = queue.commands.filter((command) => command.zIndex === Z_LAYERS.GRID + 1);
  const filledTiles = fills.map((command) => {
    if (command.kind === 'poly2d') {
      expect(command.stroke).toBeUndefined();
      expect(command.points).toHaveLength(4);
      return [command.points[0].x, command.points[0].y];
    }
    if (command.kind === 'mesh3d' && 'positions' in command && command.positions instanceof Float32Array)
      return [command.positions[0], command.positions[1]];
    return expect.fail('Expected safe region fill geometry');
  });
  expect(filledTiles.map((tile) => tile.join(',')).sort()).toEqual(tiles.map((tile) => tile.join(',')).sort());
}

describe.each(['2d', '3d'] as const)('Zuk safe tiles in %s', (renderMode) => {
  it('outlines an adjacent rectangle without shared internal edges', () => {
    const { scene, bounds, draw } = safeScene(renderMode);
    setArenaConfig({ bounds, walkableTiles: new Set(['29,44', '30,44', '29,45', '30,45']), collisionMap: null }, true);

    const queue = draw();

    expectSafeBoundary(queue, [
      [29, 44],
      [30, 44],
      [29, 45],
      [30, 45],
    ]);
    expect(queue.commands.filter((command) => command.zIndex === Z_LAYERS.GRID + 1)).toHaveLength(4);
    scene.dispose();
  });

  it('retains the boundary of an unwalkable hole without interior tile divisions', () => {
    const { scene, bounds, draw } = safeScene(renderMode);
    const tiles = [
      [29, 44],
      [30, 44],
      [31, 44],
      [29, 45],
      [31, 45],
      [29, 46],
      [30, 46],
      [31, 46],
    ];
    setArenaConfig({ bounds, walkableTiles: new Set(tiles.map((tile) => tile.join(','))), collisionMap: null }, true);

    const queue = draw();

    expectSafeBoundary(queue, tiles);
    expect(safeEdges(queue)).toHaveLength(16);
    expect(safeEdges(queue)).toEqual(
      expect.arrayContaining([
        [30, 45, 31, 45],
        [31, 45, 31, 46],
        [30, 46, 31, 46],
        [30, 45, 30, 46],
      ]),
    );
    scene.dispose();
  });

  it('keeps diagonal tile contacts joined without adding borders or duplicate half edges', () => {
    const { scene, bounds, draw } = safeScene(renderMode);
    const tiles = [
      [29, 44],
      [30, 45],
    ];
    setArenaConfig({ bounds, walkableTiles: new Set(tiles.map((tile) => tile.join(','))), collisionMap: null }, true);

    const queue = draw();

    expectSafeBoundary(queue, tiles);
    if (renderMode === '2d') {
      const crossing = queue.commands.filter(
        (command) =>
          command.kind === 'poly2d' &&
          command.zIndex === Z_LAYERS.GRID + 2 &&
          command.points[1].x === 30 &&
          command.points[1].y === 45,
      );
      expect(crossing).toHaveLength(2);
      for (const command of crossing) {
        if (command.kind !== 'poly2d') expect.fail('Expected joined path');
        const [start, , end] = command.points;
        expect(start.x === end.x || start.y === end.y).toBe(true);
      }
    }
    scene.dispose();
  });

  it('paints only shielded walkable tiles inside runtime bounds, including both shield edges', () => {
    const { scene, draw } = safeScene(renderMode);

    const queue = draw();

    expectSafeBoundary(queue, [
      [29, 44],
      [30, 44],
      [30, 48],
      [33, 44],
    ]);
    const borders = queue.commands.filter((command) => command.zIndex === Z_LAYERS.GRID + 2);
    const markers = queue.commands.filter(
      (command) => command.zIndex === Z_LAYERS.TARGET || command.zIndex === Z_LAYERS.PLAYER - 1,
    );
    expect(markers.length).toBeGreaterThan(0);
    expect(
      markers.every((command) => queue.commands.indexOf(command) > queue.commands.indexOf(borders[borders.length - 1])),
    ).toBe(true);
    scene.dispose();
  });

  it.each([
    0, 0.5, 0.99,
  ])('paints the published next-tick shield x, not the shield actor or interpolation, at fraction %s', (fraction) => {
    const { scene, state, draw } = safeScene(renderMode);
    draw();
    const moved: SimulationState = {
      ...state,
      currentTick: 1,
      encounter: zukSnapshot({ shieldX: 30, shieldNextX: 31, shieldMovingEast: true }),
      npcs: state.npcs.map((npc) =>
        npc.archetypeId === 'zuk_shield' ? { ...npc, previousPosition: [29, 47], position: [30, 47] } : npc,
      ),
    };

    const queue = draw({ simulationState: moved, interpolatedTick: 1 + fraction });

    expectSafeBoundary(queue, [
      [30, 44],
      [30, 48],
      [33, 44],
      [34, 44],
    ]);
    scene.dispose();
  });

  it('follows a westward projection independently of the shield actor position', () => {
    const { scene, state, draw } = safeScene(renderMode);
    draw();

    const queue = draw({
      simulationState: {
        ...state,
        encounter: zukSnapshot({ shieldX: 30, shieldNextX: 29, shieldMovingEast: false }),
      },
    });

    expectSafeBoundary(queue, [
      [28, 44],
      [29, 44],
      [30, 44],
      [30, 48],
    ]);
    scene.dispose();
  });

  it('paints no tile when the projection is null despite a live shield actor', () => {
    const { scene, state, draw } = safeScene(renderMode);
    draw();

    const queue = draw({
      simulationState: { ...state, encounter: zukSnapshot({ shieldX: 30, shieldNextX: null, shieldMovingEast: true }) },
    });

    expectSafeBoundary(queue, []);
    expect(queue.commands.filter((command) => command.zIndex === Z_LAYERS.GRID + 2)).toEqual([]);
    scene.dispose();
  });

  it.each(['absent', 'dead'] as const)('paints no tile when the shield is %s despite stale shieldX', (shield) => {
    const { scene, state, draw } = safeScene(renderMode);
    const npcs = state.npcs.flatMap((npc) =>
      npc.archetypeId === 'zuk_shield' ? (shield === 'absent' ? [] : [{ ...npc, alive: false }]) : [npc],
    );

    const queue = draw({ simulationState: { ...state, npcs } });

    expectSafeBoundary(queue, []);
    expect(queue.commands.filter((command) => command.zIndex === Z_LAYERS.GRID + 2)).toEqual([]);
    scene.dispose();
  });

  it('selects the first live shield rather than an earlier corpse or same-type unrelated actor', () => {
    const { scene, state, draw } = safeScene(renderMode);
    const shield = state.npcs.find((npc) => npc.archetypeId === 'zuk_shield');
    if (!shield) expect.fail('Expected shield fixture');
    const npcs: SimulationState['npcs'] = [
      { ...shield, id: 'corpse', alive: false, position: [20, 47] },
      { ...shield, id: 'unrelated', archetypeId: 'other', position: [20, 47] },
      ...state.npcs,
    ];

    const queue = draw({ simulationState: { ...state, npcs } });

    expectSafeBoundary(queue, [
      [29, 44],
      [30, 44],
      [30, 48],
      [33, 44],
    ]);
    scene.dispose();
  });

  it.each([
    'off',
    'non-zuk',
    'dead-boss',
    'absent-boss',
  ] as const)('clears previously painted tiles when %s', (condition) => {
    const { scene, state, context, draw } = safeScene(renderMode);
    expect(safeEdges(draw())).toHaveLength(14);
    const next: RenderContext = { ...context };
    switch (condition) {
      case 'off':
        next.simulationState = { ...state, mechanicsConfig: { ...state.mechanicsConfig, zukShieldSafeTiles: false } };
        break;
      case 'non-zuk':
        next.simulationState = { ...state, encounter: { kind: 'lobby', state: {}, visuals: {} } };
        break;
      case 'dead-boss':
        next.simulationState = {
          ...state,
          npcs: state.npcs.map((npc) => (npc.archetypeId === 'zuk' ? { ...npc, alive: false } : npc)),
        };
        break;
      case 'absent-boss':
        next.simulationState = { ...state, npcs: state.npcs.filter((npc) => npc.archetypeId !== 'zuk') };
        break;
      default: {
        const exhaustive: never = condition;
        throw exhaustive;
      }
    }

    const queue = draw(next);

    expectSafeBoundary(queue, []);
    expect(queue.commands.filter((command) => command.zIndex === Z_LAYERS.GRID + 2)).toEqual([]);
    scene.dispose();
  });

  it('follows arena walkability replacement without retaining old tiles', () => {
    const { scene, bounds, draw } = safeScene(renderMode);
    draw();
    setArenaConfig({ bounds, walkableTiles: new Set(['33,44']), collisionMap: null }, true);

    const queue = draw();

    expectSafeBoundary(queue, [[33, 44]]);
    scene.dispose();
  });

  it('follows in-place walkability changes without retaining old tiles', () => {
    const { scene, walkableTiles, draw } = safeScene(renderMode);
    draw();
    walkableTiles.delete('29,44');

    const queue = draw();

    expectSafeBoundary(queue, [
      [30, 44],
      [30, 48],
      [33, 44],
    ]);
    scene.dispose();
  });

  it.each([0, 1, 13, 14])('keeps shield coverage steady at tick %s during paused replay seeks', (currentTick) => {
    const { scene, state, draw } = safeScene(renderMode);
    draw({ simulationState: { ...state, currentTick: 30 }, interpolatedTick: 30 });

    const queue = draw({
      simulationState: { ...state, currentTick },
      interpolatedTick: currentTick,
      timeline: { timelineKey: 'replay', paused: true },
    });

    expectSafeBoundary(queue, [
      [29, 44],
      [30, 44],
      [30, 48],
      [33, 44],
    ]);
    scene.dispose();
  });

  it('paints a paused replay frame from its stored projection rather than the live shield actor', () => {
    const { scene, state, draw } = safeScene(renderMode);
    draw();
    const stored: SimulationState = {
      ...state,
      currentTick: 5,
      encounter: zukSnapshot({ shieldX: 30, shieldNextX: 31, shieldMovingEast: true }),
    };

    const queue = draw({
      simulationState: stored,
      interpolatedTick: 5.5,
      timeline: { timelineKey: 'replay', paused: true },
      replayHistory: { frames: [{ state: stored, events: [] }], throughFrameIndex: 0 },
    });

    expectSafeBoundary(queue, [
      [30, 44],
      [30, 48],
      [33, 44],
      [34, 44],
    ]);
    scene.dispose();
  });

  it('leaves unknown walkability unpainted instead of filling the fallback rectangle', () => {
    const { scene, bounds, draw } = safeScene(renderMode);
    setArenaConfig({ bounds, walkableTiles: null, collisionMap: null }, true);

    const queue = draw();

    expectSafeBoundary(queue, []);
    scene.dispose();
  });
});

describe('Zuk safe tile presentation', () => {
  it.each(['2d', '3d'] as const)('adds a four-percent jade fill beneath the perimeter in %s', (renderMode) => {
    const { scene, bounds, draw } = safeScene(renderMode);
    setArenaConfig({ bounds, walkableTiles: new Set(['29,44', '30,44']), collisionMap: null }, true);

    const queue = draw();

    expectSafeBoundary(queue, [
      [29, 44],
      [30, 44],
    ]);
    const fills = queue.commands.filter((command) => command.zIndex === Z_LAYERS.GRID + 1);
    expect(fills).toHaveLength(2);
    if (renderMode === '2d') {
      expect(fills[0]).toMatchObject({
        kind: 'poly2d',
        fill: { r: 121 / 255, g: 201 / 255, b: 158 / 255, a: 0.04 },
        points: [
          { x: 29, y: 44 },
          { x: 30, y: 44 },
          { x: 30, y: 45 },
          { x: 29, y: 45 },
        ],
      });
    } else {
      expect(fills[0]).toMatchObject({
        kind: 'mesh3d',
        perVertexAlphas: new Float32Array(6).fill(0.04),
        perVertexHslColors: new Float32Array(6).fill(rgbToHsl(0x79c99e)),
        positions: new Float32Array([
          29, 44, 73.008, 30, 44, 74.008, 30, 45, 75.008, 29, 44, 73.008, 30, 45, 75.008, 29, 45, 74.008,
        ]),
      });
    }
    scene.dispose();
  });

  it('matches regular tile-outline corner coverage without changing standalone edge caps', () => {
    const { scene, bounds, draw } = safeScene('3d');
    setArenaConfig({ bounds, walkableTiles: new Set(['29,44']), collisionMap: null }, true);
    const reference: RenderQueue = {
      replayPresentationReady: true,
      commands: [scene['createOutlineMesh3D'](29, 44, 29, 44, 100, 0.04, Z_LAYERS.GRID + 2, 0.65)],
    };
    const standalone = scene['createEdgeMesh3D'](29, 44, 30, 44, 100);

    const queue = draw();

    for (const [x, y] of [
      [29, 44],
      [30, 44],
      [30, 45],
      [29, 45],
    ]) {
      for (const dx of [-0.027, -0.006, 0.006, 0.027]) {
        for (const dy of [-0.023, -0.013, 0.013, 0.023]) {
          expect(coverageAt(queue, [x + dx, y + dy])).toBe(coverageAt(reference, [x + dx, y + dy]));
        }
      }
    }
    expect(standalone.positions).toHaveLength(18);
    expect(Array.from(standalone.positions).filter((_, index) => index % 3 === 0)).toEqual([29, 30, 30, 29, 30, 29]);
    scene.dispose();
  });

  it('covers the outer corner square when perpendicular shield edges meet', () => {
    const { scene, bounds, draw } = safeScene('3d');
    setArenaConfig({ bounds, walkableTiles: new Set(['29,44']), collisionMap: null }, true);

    const queue = draw();

    expect(coverageAt(queue, [28.994, 43.987])).toBe(1);
    scene.dispose();
  });

  it('places a 2D corner inside one joined path instead of at separate butt caps', () => {
    const { scene, bounds, draw } = safeScene('2d');
    setArenaConfig({ bounds, walkableTiles: new Set(['29,44']), collisionMap: null }, true);

    const queue = draw();

    expect(queue.commands.filter((command) => command.zIndex === Z_LAYERS.GRID + 2)).toContainEqual(
      expect.objectContaining({
        kind: 'poly2d',
        points: [
          { x: 29.5, y: 44 },
          { x: 29, y: 44 },
          { x: 29, y: 44.5 },
        ],
        closePath: false,
      }),
    );
    scene.dispose();
  });

  it('emits soft jade joined paths without polygon fills in 2D', () => {
    const { scene, draw } = safeScene('2d');

    const queue = draw();

    const borders = queue.commands.filter((command) => command.zIndex === Z_LAYERS.GRID + 2);
    expect(borders).toHaveLength(14);
    expect(borders[0]).toMatchObject({
      kind: 'poly2d',
      points: [
        { x: 29.5, y: 44 },
        { x: 29, y: 44 },
        { x: 29, y: 44.5 },
      ],
      closePath: false,
      stroke: { color: { r: 121 / 255, g: 201 / 255, b: 158 / 255, a: 0.65 }, widthPx: 2 },
    });
    expect(borders[0]).not.toHaveProperty('fill');
    scene.dispose();
  });

  it('emits terrain-following 3D fill and perimeter meshes below player and target markers', () => {
    const { scene, draw } = safeScene('3d');

    const queue = draw();

    const fills = queue.commands.filter((command) => command.zIndex === Z_LAYERS.GRID + 1);
    const borders = queue.commands.filter((command) => command.zIndex === Z_LAYERS.GRID + 2);
    expect(fills).toHaveLength(4);
    expect(borders).toHaveLength(26);
    expect(borders[0]).toMatchObject({
      kind: 'mesh3d',
      materialId: 'tile-outline',
      depth: 'none',
      cullFace: 'none',
      perVertexHslColors: new Float32Array(6).fill(rgbToHsl(0x79c99e)),
    });
    const border = borders[0];
    if (!('positions' in border) || !(border.positions instanceof Float32Array))
      expect.fail('Expected border geometry');
    expect(Array.from(border.positions.slice(0, 9))).toEqual(
      Array.from(new Float32Array([29, 43.98, 73.01, 30, 43.98, 74.01, 30, 44.02, 74.01])),
    );
    expect(border).toHaveProperty('perVertexAlphas', new Float32Array(border.positions.length / 3).fill(0.65));
    for (const command of borders) {
      if (command.kind !== 'mesh3d' || !command.meshId.startsWith('edge-join-')) continue;
      if (!('positions' in command) || !(command.positions instanceof Float32Array)) expect.fail('Missing join');
      const [x, y] = command.positions;
      const height = Math.fround(x + y + 0.01);
      expect(Array.from(command.positions).filter((_, index) => index % 3 === 2)).toEqual(Array(6).fill(height));
      expect(command).toHaveProperty('perVertexAlphas', new Float32Array(6).fill(0.65));
      expect(command).toHaveProperty('perVertexHslColors', Reflect.get(border, 'perVertexHslColors'));
    }
    scene.dispose();
  });

  it.each([
    { mask: 0, coverage: [0, 0, 0, 0] },
    { mask: 1, coverage: [2, 1, 1, 1] },
    { mask: 2, coverage: [1, 2, 1, 1] },
    { mask: 3, coverage: [1, 1, 1, 1] },
    { mask: 4, coverage: [1, 1, 2, 1] },
    { mask: 5, coverage: [2, 2, 2, 2] },
    { mask: 6, coverage: [1, 1, 1, 1] },
    { mask: 7, coverage: [1, 1, 1, 2] },
    { mask: 8, coverage: [1, 1, 1, 2] },
    { mask: 9, coverage: [1, 1, 1, 1] },
    { mask: 10, coverage: [2, 2, 2, 2] },
    { mask: 11, coverage: [1, 1, 2, 1] },
    { mask: 12, coverage: [1, 1, 1, 1] },
    { mask: 13, coverage: [1, 2, 1, 1] },
    { mask: 14, coverage: [2, 1, 1, 1] },
    { mask: 15, coverage: [0, 0, 0, 0] },
  ])('covers convex, concave, straight and diagonal junctions without extra overlap: $mask', ({ mask, coverage }) => {
    const { scene, bounds, draw } = safeScene('3d');
    const tiles = [
      [29, 44],
      [30, 44],
      [30, 45],
      [29, 45],
    ].filter((_, index) => mask & (1 << index));
    setArenaConfig({ bounds, walkableTiles: new Set(tiles.map((tile) => tile.join(','))), collisionMap: null }, true);

    const queue = draw();

    expect(
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([dx, dy]) => coverageAt(queue, [30 + dx * 0.006, 45 + dy * 0.013])),
    ).toEqual(coverage);
    for (const [x, y] of tiles) expect(coverageAt(queue, [x + 0.4, y + 0.6])).toBe(0);
    expectSafeBoundary(queue, tiles);
    scene.dispose();
  });

  it('closes every concave hole corner without stroking the hole or safe interior', () => {
    const { scene, bounds, draw } = safeScene('3d');
    const tiles = [
      [29, 44],
      [30, 44],
      [31, 44],
      [29, 45],
      [31, 45],
      [29, 46],
      [30, 46],
      [31, 46],
    ];
    setArenaConfig({ bounds, walkableTiles: new Set(tiles.map((tile) => tile.join(','))), collisionMap: null }, true);

    const queue = draw();

    for (const [x, y] of [
      [29.994, 44.987],
      [31.006, 44.987],
      [31.006, 46.013],
      [29.994, 46.013],
    ]) {
      expect(coverageAt(queue, [x, y])).toBe(1);
    }
    expect(coverageAt(queue, [30.4, 45.6])).toBe(0);
    expectSafeBoundary(queue, tiles);
    scene.dispose();
  });
});

describe('Zuk scene builder', () => {
  it.each([
    false,
    true,
  ])('hands off historical Zuk aiming through the compositor (empty live frame: %s)', async (emptyLiveFrame) => {
    const restored = await frameAudio();
    const live = await frameAudio();
    try {
      const { engine } = restored;
      engine.reset([40, 46]);
      engine.setMechanicsConfig({ zukSets: false, infiniteHealth: true });
      let emitted: EncounterVisualEvent | undefined;
      for (let tick = 0; tick < 40 && !emitted; tick++) {
        engine.advanceTick([40, 46]);
        emitted = engine
          .getLastTickEvents()
          .filter(isEncounterVisualEvent)
          .find((event) => event.projectiles.some((cue) => cue.spotAnimId === 1375));
      }
      const cue = emitted?.projectiles.find((cue) => cue.spotAnimId === 1375);
      if (!emitted || !cue) expect.fail('Expected real engine-generated Zuk ball');
      const base = emitted.tick * 30;
      const state = engine.getState();
      const frames: ReplayDisplayFrame[] = [
        { state: { ...restored.state, currentTick: emitted.tick - 1 }, events: [] },
      ];
      const restoration: RestoredPresentation = {
        engine,
        tick: emitted.tick - 1,
        timeMs: (base - 30) * 20,
        history: { frames, throughFrameIndex: 0 },
      };
      restored.draw(base - 30, {
        simulationState: frames[0].state,
        events: [],
        restoredPresentation: restoration,
      });
      expect(restored.scene['cues']['replay']).toBeDefined();
      const clear = vi.spyOn(restored.scene['cues'], 'clear');
      if (emptyLiveFrame) {
        restored.draw(base, { simulationState: state, events: [], restoredPresentation: restoration });
        expect(clear).not.toHaveBeenCalled();
        expect(restored.scene['cues']['replay']).toBeUndefined();
      }
      const effects = (queue: RenderQueue) =>
        queue.commands.flatMap((command) =>
          command.kind === 'mesh3d' && command.meshId === 'effect-1375' ? [Array.from(command.modelMatrix)] : [],
        );
      restored.draw(base, { simulationState: state, events: [emitted], restoredPresentation: restoration });
      live.draw(base, { simulationState: state, events: [emitted] });
      expect(clear).not.toHaveBeenCalled();
      expect(restored.scene['cues']['replay']).toBeUndefined();
      const start = base + cue.startDelayCycles;
      for (const cycle of [base + 30, start, start + 1]) {
        const context = { simulationState: { ...state, currentTick: Math.floor(cycle / 30) }, events: [] };
        const meshes = effects(restored.draw(cycle, { ...context, restoredPresentation: restoration }));
        expect(meshes).toEqual(effects(live.draw(cycle, context)));
        if (cycle >= start) expect(meshes).toHaveLength(1);
      }
      const motion = [...restored.scene['cues']['flights']['flights'].values()][0]?.runtime['motion'];
      if (!motion) expect.fail('Expected airborne Zuk ball');
      expect(motion.velocity.x).toBeGreaterThan(0);
      const arrival = advanceProjectileMotion(motion, base + cue.endDelayCycles - (start + 1));
      expect(arrival.position.x).toBeCloseTo(40.5, 12);
      expect(arrival.position.y).toBeCloseTo(46.5, 12);
    } finally {
      restored.scene.dispose();
      live.scene.dispose();
    }
  });

  it('advances Inferno animation exactly once when restored history hands off 150 ms after GO', async () => {
    const { engine, scene, draw, state } = await frameAudio();
    try {
      const manager = scene['npcInstanceManager'];
      const event: EncounterVisualEvent = {
        type: 'encounter_visual',
        eventId: 1,
        tick: 0,
        graphics: [],
        projectiles: [],
        animations: [{ actorId: ZUK_ACTOR_ID, clipId: 'attack', delayCycles: 29 }],
      };
      const restoration: RestoredPresentation = {
        engine,
        tick: 0,
        timeMs: 600,
        history: { frames: [{ state, events: [event] }], throughFrameIndex: 0 },
      };
      for (let frame = 0; frame < 3; frame++)
        draw(30, {
          simulationState: state,
          events: [event],
          restoredPresentation: restoration,
          frameDeltaMs: 0,
          timeline: { timelineKey: 'restored-inferno', paused: true, timeMs: 600 },
        });
      const controller = manager['instanceRegistry'].get(PRIMARY_NPC_ACTOR_ID)?.animController;
      if (!controller) expect.fail('Missing restored Inferno animation controller');
      expect(controller['primaryTrack']?.elapsedTicks).toBe(1);
      const advance = vi.spyOn(manager, 'updateAnimations');
      draw(37.5, {
        events: [],
        restoredPresentation: restoration,
        frameDeltaMs: 150,
        timeline: { timelineKey: 'restored-inferno', paused: false, timeMs: 750 },
      });
      expect(advance.mock.calls.reduce((total, [delta, speed]) => total + delta * speed, 0)).toBeCloseTo(150);
      expect(controller['primaryTrack']?.elapsedTicks).toBe(8);
      expect(controller['tickRemainderMs']).toBeCloseTo(10);
      expect(controller.getFrameState()?.seqId).toBe(ZUK_SEQS.zuk.attack);
    } finally {
      scene.dispose();
    }
  });

  it('keeps a delayed Zuk attack in live cycle phase after restored history first initializes mid-tick', async () => {
    const live = await frameAudio();
    const restored = await frameAudio();
    try {
      const tick = 1;
      // Emitted on tick T+1 and due one tick later, so the late-initialized history has no started
      // animation to restore Zuk from: only the clock's own start sets his cycle phase.
      const attack: EncounterVisualEvent = {
        type: 'encounter_visual',
        eventId: 5,
        tick: tick + 1,
        graphics: [],
        projectiles: [],
        animations: [{ actorId: ZUK_ACTOR_ID, clipId: 'attack', delayCycles: 30 }],
      };
      const frames: ReplayDisplayFrame[] = [0, 1, 2].map((currentTick) => ({
        state: { ...restored.state, currentTick },
        events: currentTick === tick + 1 ? [attack] : [],
      }));
      const restoration: RestoredPresentation = {
        engine: restored.engine,
        tick,
        timeMs: (tick + 1) * 600,
        history: { frames, throughFrameIndex: tick },
      };
      const restoredDraw = (cycle: number, events: GameEvent[]) =>
        restored.draw(cycle, {
          events,
          restoredPresentation: restoration,
          frameDeltaMs: 150,
          timeline: { timelineKey: 'restored-inferno', paused: false, timeMs: cycle * 20 },
        });
      const zuk = (setup: Awaited<ReturnType<typeof frameAudio>>) => {
        const controller =
          setup.scene['npcInstanceManager']['instanceRegistry'].get(PRIMARY_NPC_ACTOR_ID)?.animController;
        if (!controller) expect.fail('Missing Zuk animation controller');
        return {
          seqId: controller.getFrameState()?.seqId,
          elapsed: controller['primaryTrack']?.elapsedTicks,
          remainderMs: controller['tickRemainderMs'],
        };
      };
      restoredDraw(67.5, [attack]);
      expect(restored.scene['replayEffectIndex']).toBeDefined();
      restoredDraw(75, [attack]);
      expect(restored.scene['replayEffectIndex']).toBeUndefined();
      for (const cycle of [60, 67.5, 75]) live.draw(cycle, { events: [attack] });
      // The fixture attack lasts 10 cycles (frames of 2, 3 and 5).
      for (const cycle of [90, 92.5, 97.5]) {
        live.draw(cycle, { events: [] });
        restoredDraw(cycle, []);
        const expected = zuk(live);
        expect(expected.seqId).toBe(ZUK_SEQS.zuk.attack);
        expect(zuk(restored), `cycle ${cycle}`).toEqual(expected);
      }
    } finally {
      live.scene.dispose();
      restored.scene.dispose();
    }
  });

  it('bounds repeated seek history reads and animation updates after indexing a long history', async () => {
    const { scene, draw, state, play } = await frameAudio();
    let reads = 0;
    const frame = (tick: number): ReplayDisplayFrame => ({
      state: { ...state, currentTick: tick },
      get events() {
        reads++;
        return [
          {
            type: 'encounter_visual',
            tick,
            eventId: tick + 1,
            projectiles: [],
            graphics: [],
            animations: [{ actorId: ZUK_ACTOR_ID, clipId: 'attack', delayCycles: 2 }],
          } satisfies EncounterVisualEvent,
        ];
      },
    });
    const frames = Array.from({ length: 3000 }, (_, tick) => frame(tick));
    const seek = (tick: number) =>
      draw(tick * 30 + 5, { events: [], replayHistory: { frames, throughFrameIndex: tick } });
    seek(2999);
    reads = 0;
    const update = vi.spyOn(NpcAnimationController.prototype, 'update');
    for (const tick of [2000, 1000, 2500, 500]) {
      update.mockClear();
      seek(tick);
      expect(update.mock.calls.length).toBeLessThan(10);
    }
    expect(reads).toBe(0);
    expect(play).not.toHaveBeenCalled();
    frames.push(frame(3000));
    seek(3000);
    expect(reads).toBe(1);
    expect(
      scene['npcInstanceManager']
        .getInstanceFrameStates()
        .find((entry) => entry.actorId === PRIMARY_NPC_ACTOR_ID)
        ?.animController?.getFrameState(),
    ).toMatchObject({ seqId: ZUK_SEQS.zuk.attack, currentFrameIndex: 1 });
    scene.dispose();
  });
  it.each([
    false,
    true,
  ])('uses scene elevation for live and replay flight while leaving graphics unchanged: replay=%s', async (replay) => {
    const { scene, draw, state } = await frameAudio();
    const source = [20, 20] as const;
    const emitted: EncounterVisualEvent = {
      type: 'encounter_visual',
      eventId: 10,
      tick: 0,
      animations: [],
      projectiles: [
        {
          spotAnimId: 660,
          sourcePosition: [...source],
          target: { kind: 'tile', position: [25, 25] },
          startDelayCycles: 0,
          endDelayCycles: 29,
          slope: 0,
          startOffset: 64,
          startHeight: 390,
          endHeight: 124,
        },
      ],
      graphics: [{ spotAnimId: 444, target: { kind: 'tile', position: [25, 25] }, delayCycles: 0, height: 64 }],
    };
    vi.spyOn(scene['surfaceHeightResolver'], 'hasTerrain', 'get').mockReturnValue(true);
    vi.spyOn(scene['surfaceHeightResolver'], 'resolve').mockImplementation((worldX) => (worldX < 21 ? -256 : -768));

    const queue = draw(
      15,
      replay
        ? { events: [], replayHistory: { frames: [{ state, events: [emitted] }], throughFrameIndex: 0 } }
        : { events: [emitted] },
    );

    const flight = queue.commands.find((command) => command.kind === 'mesh3d' && command.meshId === 'effect-660');
    const graphic = queue.commands.find((command) => command.kind === 'mesh3d' && command.meshId === 'effect-444');
    if (!flight || flight.kind !== 'mesh3d' || !graphic || graphic.kind !== 'mesh3d') expect.fail('Missing effects');
    // Zero slope gives z(t) = z0 + (zt - z0) * (t / horizon)^2, and the horizon is the
    // packet end cycle 29, so cycle 15 is not exactly the quarter point. Both endpoints
    // still come from the mocked scene elevation (-256 at the source, -768 at the target).
    const sourceZ = (390 + 256) / 128;
    const targetZ = (124 + 768) / 128;
    expect(flight.modelMatrix[14]).toBeCloseTo(sourceZ + (targetZ - sourceZ) * (15 / 29) ** 2);
    expect(graphic.modelMatrix[14]).toBe(0.5);
    scene.dispose();
  });

  it('restores actor-local animation age without pre-aging late spawns or destination corpses', async () => {
    const { scene, draw, state } = await frameAudio();
    const manager = scene['npcInstanceManager'];
    const late = {
      ...makeSnapshot({ id: 'late', npcTypeId: 7705, position: [20, 20], size: 1 }),
      spawnTick: 10,
      history: new Map(),
    };
    const lateActive = { ...late, id: 'late-active', npcTypeId: ZUK_NPC_ID };
    const dead = { ...late, id: 'corpse', alive: false, spawnTick: 0, despawnTick: 10 };
    const destination = { ...state, currentTick: 10, npcs: [...state.npcs, late, lateActive, dead] };
    const frames: ReplayDisplayFrame[] = [
      {
        state,
        events: [
          {
            type: 'encounter_visual',
            eventId: 1,
            tick: 0,
            projectiles: [],
            graphics: [],
            animations: [
              { actorId: 'absent', clipId: 'attack', delayCycles: 0 },
              { actorId: 'late', clipId: 'heal', delayCycles: 0 },
              { actorId: 'late-active', clipId: 'attack', delayCycles: 300 },
              { actorId: ZUK_ACTOR_ID, clipId: 'attack', delayCycles: 300 },
            ],
          } satisfies EncounterVisualEvent,
        ],
      },
      { state: destination, events: [] },
    ];

    draw(303, { simulationState: destination, events: [], replayHistory: { frames, throughFrameIndex: 1 } });

    expect(
      manager
        .getInstanceFrameStates()
        .find((entry) => entry.actorId === PRIMARY_NPC_ACTOR_ID)
        ?.animController?.getFrameState(),
    ).toMatchObject({ seqId: ZUK_SEQS.zuk.attack, currentFrameIndex: 1 });
    expect(manager['instanceRegistry'].get('late')?.animController?.['baseTrack']?.elapsedTicks).toBe(0);
    expect(manager['instanceRegistry'].get('late-active')?.animController?.['baseTrack']?.elapsedTicks).toBe(3);
    expect(manager['instanceRegistry'].get('late-active')?.animController?.getFrameState()).toMatchObject({
      seqId: ZUK_SEQS.zuk.attack,
      currentFrameIndex: 1,
    });
    expect(manager['dyingInstances'].get('corpse')?.deathTimerMs).toBeCloseTo(60);
    expect(manager['pendingAttackTriggersByActor'].has('absent')).toBe(false);
    scene.dispose();
  });

  it('reconstructs a still-active pruned corpse at exact age after same-tick history replacement', async () => {
    const { scene, draw, state } = await frameAudio();
    const alive = {
      ...makeSnapshot({ id: 'healer', npcTypeId: 7705, position: [20, 20], size: 1 }),
      spawnTick: 0,
      history: new Map(),
    };
    const dead = { ...alive, alive: false, hp: 0, despawnTick: 1 };
    const aliveState = { ...state, currentTick: 0, npcs: [...state.npcs, alive] };
    const deadState = { ...state, currentTick: 1, npcs: [...state.npcs, dead] };
    const prunedState = { ...state, currentTick: 1, npcs: state.npcs };
    const frames: ReplayDisplayFrame[] = [
      { state: aliveState, events: [] },
      { state: deadState, events: [] },
      { state: prunedState, events: [] },
    ];

    draw(31, { simulationState: deadState, events: [], replayHistory: { frames, throughFrameIndex: 1 } });
    draw(35, {
      simulationState: prunedState,
      events: [],
      replayHistory: { frames: [...frames], throughFrameIndex: 2 },
    });

    expect(scene['npcInstanceManager'].getDyingActorIds()).toContain('healer');
    expect(scene['npcInstanceManager']['dyingInstances'].get('healer')?.deathTimerMs).toBe(100);
    scene.dispose();
  });

  it('reconstructs a pruned corpse from restored history exactly as replay does at the same cutoff', async () => {
    const corpses = async (restored: boolean) => {
      const { scene, draw, state, engine } = await frameAudio();
      const manager = scene['npcInstanceManager'];
      vi.spyOn(manager, 'getMaximumLoadedDeathDurationMs').mockReturnValue(6000);
      const reconstruct = vi.spyOn(manager, 'reconstructDyingInstance');
      const alive = {
        ...makeSnapshot({ id: 'healer', npcTypeId: 7705, position: [20, 20], size: 1 }),
        spawnTick: 0,
        history: new Map(),
      };
      const frames: ReplayDisplayFrame[] = [
        { state: { ...state, currentTick: 0, npcs: [...state.npcs, alive] }, events: [] },
        {
          state: { ...state, currentTick: 1, npcs: [...state.npcs, { ...alive, alive: false, hp: 0, despawnTick: 1 }] },
          events: [],
        },
        { state: { ...state, currentTick: 2, npcs: state.npcs }, events: [] },
      ];
      const timeMs = 3 * 600;
      const history = { frames, throughFrameIndex: 2 };
      const restoration: RestoredPresentation = { engine, tick: 2, timeMs, history };
      draw(timeMs / 20, {
        simulationState: frames[2].state,
        events: [],
        ...(restored ? { restoredPresentation: restoration } : { replayHistory: history }),
        frameDeltaMs: 0,
        timeline: { timelineKey: restored ? 'restored-inferno' : 'replay', paused: true, timeMs },
      });
      const calls = reconstruct.mock.calls.filter(([npc]) => npc.id === 'healer').map(([, elapsed]) => elapsed);
      scene.dispose();
      return calls;
    };
    const replay = await corpses(false);
    expect(replay.length).toBeGreaterThan(0);
    expect(await corpses(true)).toEqual(replay);
  });

  it('does not hand restored history to live until its effect assets have settled', async () => {
    const { scene, draw, state, engine } = await frameAudio();
    try {
      const renderer = scene['spotAnimRenderer'];
      const graphic = renderer['meshCache'].get(444);
      if (!graphic) expect.fail('Missing loaded effect fixture');
      renderer['meshCache'].delete(444);
      const event: EncounterVisualEvent = {
        type: 'encounter_visual',
        tick: 0,
        eventId: 1,
        projectiles: [],
        graphics: [{ spotAnimId: 444, target: { kind: 'tile', position: [25, 25] }, delayCycles: 0, height: 0 }],
        animations: [],
      };
      const frames: ReplayDisplayFrame[] = [{ state, events: [event] }];
      const restoration: RestoredPresentation = {
        engine,
        tick: 0,
        timeMs: 600,
        history: { frames, throughFrameIndex: 0 },
      };
      for (let frame = 0; frame < 3; frame++)
        draw(30, {
          simulationState: state,
          events: [event],
          restoredPresentation: restoration,
          frameDeltaMs: 0,
          timeline: { timelineKey: 'restored-inferno', paused: true, timeMs: 600 },
        });
      expect(renderer['activeInstances'].has('cue-1-graphic-0')).toBe(false);
      // The effect finishes loading as the countdown ends; the first live frame must still restore it.
      renderer['meshCache'].set(444, graphic);
      const live = { ...state, currentTick: 1 };
      frames.push({ state: live, events: [] });
      draw(35, {
        simulationState: live,
        events: [],
        restoredPresentation: restoration,
        frameDeltaMs: 100,
        timeline: { timelineKey: 'restored-inferno', paused: false, timeMs: 700 },
      });
      expect(renderer['activeInstances'].get('cue-1-graphic-0')?.lifecycle).toMatchObject({ startTick: 0 });
      draw(40, {
        simulationState: live,
        events: [],
        restoredPresentation: restoration,
        frameDeltaMs: 100,
        timeline: { timelineKey: 'restored-inferno', paused: false, timeMs: 800 },
      });
      expect(scene['cues']['replay']).toBeUndefined();
      expect(renderer['activeInstances'].get('cue-1-graphic-0')?.lifecycle).toMatchObject({ startTick: 0 });
    } finally {
      scene.dispose();
    }
  });

  it('keeps a live replacement actor ahead of an active historical corpse with the same id', async () => {
    const { scene, draw, state } = await frameAudio();
    const first = {
      ...makeSnapshot({ id: 'healer', npcTypeId: 7705, position: [20, 20], size: 1 }),
      spawnTick: 0,
      alive: false,
      hp: 0,
      despawnTick: 1,
      history: new Map(),
    };
    const replacement: NpcState = {
      ...makeSnapshot({ id: 'healer', npcTypeId: 7705, position: [24, 20], size: 1 }),
      spawnTick: 1,
      history: new Map(),
    };
    const deathState = { ...state, currentTick: 1, npcs: [...state.npcs, first] };
    const replacementState = { ...state, currentTick: 1, npcs: [...state.npcs, replacement] };
    const frames: ReplayDisplayFrame[] = [
      { state: deathState, events: [] },
      { state: replacementState, events: [] },
    ];

    draw(35, { simulationState: replacementState, events: [], replayHistory: { frames, throughFrameIndex: 1 } });

    expect(scene['npcInstanceManager'].getDyingActorIds()).not.toContain('healer');
    expect(scene['npcInstanceManager'].getVisualPosition('healer')).toEqual([24, 20]);
    scene.dispose();
  });

  it('holds replay readiness only while a required NPC reconstruction load is unsettled', async () => {
    const { scene, draw, state } = await frameAudio();
    const manager = scene['npcInstanceManager'];
    manager['typeRegistry'].delete(7705);
    let rejectPending: ((reason: Error) => void) | undefined;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectPending = reject;
    });
    vi.spyOn(manager, 'loadNpcType').mockReturnValueOnce(pending);
    const { loader, animation } = assets();
    const attempt = scene.loadNpcType(7705, loader, animation);
    const frames: ReplayDisplayFrame[] = [{ state, events: [] }];

    expect(draw(0, { events: [], replayHistory: { frames, throughFrameIndex: 0 } }).replayPresentationReady).toBe(
      false,
    );

    rejectPending?.(new Error('cache corrupt'));
    await expect(attempt).rejects.toThrow('cache corrupt');
    expect(draw(0, { events: [], replayHistory: { frames, throughFrameIndex: 0 } }).replayPresentationReady).toBe(true);
    scene.dispose();
  });

  it('retries a held history display only after effect and NPC loading complete', async () => {
    const { scene, draw, state } = await frameAudio();
    const renderer = scene['spotAnimRenderer'];
    const manager = scene['npcInstanceManager'];
    const graphic = renderer['meshCache'].get(444);
    const npcType = manager['typeRegistry'].get(7705);
    if (!graphic || !npcType) expect.fail('Missing loaded fixtures');
    graphic.frameLengths = [2, 3, 55];
    graphic.frames = [0, 1, 2].map((frame) =>
      graphic.static.map((mesh) => ({ ...mesh, meshId: `effect-444-frame-${frame}` })),
    );
    renderer['meshCache'].delete(444);
    manager['typeRegistry'].delete(7705);
    const frames: ReplayDisplayFrame[] = [
      {
        state,
        events: [
          {
            type: 'encounter_visual',
            tick: 0,
            eventId: 1,
            projectiles: [],
            graphics: [{ spotAnimId: 444, target: { kind: 'tile', position: [25, 25] }, delayCycles: 0, height: 0 }],
            animations: [{ actorId: ZUK_ACTOR_ID, clipId: 'attack', delayCycles: 0 }],
          } satisfies EncounterVisualEvent,
        ],
      },
    ];
    const context = { events: [], replayHistory: { frames, throughFrameIndex: 0 } };
    draw(3, context);
    renderer['meshCache'].set(444, graphic);
    draw(3, context);
    expect(scene['cueHistory']).toBeUndefined();
    manager['typeRegistry'].set(7705, npcType);

    const queue = draw(3, context);

    expect(queue.commands.some((command) => command.kind === 'mesh3d' && command.meshId === 'effect-444-frame-1')).toBe(
      true,
    );
    expect(renderer['activeInstances'].get('cue-1-graphic-0')?.lifecycle).toMatchObject({ startTick: 0 });
    expect(
      manager
        .getInstanceFrameStates()
        .find((entry) => entry.actorId === PRIMARY_NPC_ACTOR_ID)
        ?.animController?.getFrameState(),
    ).toMatchObject({ seqId: ZUK_SEQS.zuk.attack, currentFrameIndex: 1 });
    scene.dispose();
  });

  it('clears base-owned effects when history identity changes at the same displayed tick', async () => {
    const { scene, draw, state } = await frameAudio();
    const frames: ReplayDisplayFrame[] = [{ state, events: [] }];
    draw(0, { events: [], replayHistory: { frames, throughFrameIndex: 0 } });
    scene['spotAnimRenderer'].spawn({
      instanceId: 'base-owned',
      spotAnimId: 444,
      transform: { kind: 'static', value: { position: [20, 20, 0] } },
      lifecycle: { kind: 'manual' },
    });
    scene['playerGraphicController'].triggerGraphic(444, 0);
    scene['projectileTargetId'] = 'old-target';

    const queue = draw(0, { events: [], replayHistory: { frames: [...frames], throughFrameIndex: 0 } });

    expect(queue.commands.some((command) => command.kind === 'mesh3d' && command.meshId === 'effect-444')).toBe(false);
    expect(scene['projectileTargetId']).toBeNull();
    scene.dispose();
  });

  it.each([
    false,
    true,
  ])('removes the primary presentation alias when explicitly despawned and dying is %s', async (dying) => {
    const { scene, draw, state } = await frameAudio();
    const manager = scene['npcInstanceManager'];
    const primary = {
      ...makeSnapshot({ id: ZUK_ACTOR_ID, npcTypeId: ZUK_NPC_ID, position: [28, 52], size: 7 }),
      history: new Map(),
    };
    draw(0, { events: [], simulationState: { ...state, npcs: [primary] } });
    if (dying) {
      draw(1, { events: [], simulationState: { ...state, npcs: [{ ...primary, alive: false }] } });
      expect(manager.getDyingActorIds()).toContain(PRIMARY_NPC_ACTOR_ID);
      manager.updateAnimations(0, 1, [{ actorId: PRIMARY_NPC_ACTOR_ID, trigger: 'attack', tick: 1 }]);
    }

    draw(2, {
      events: [{ type: 'actor_despawned', actorId: ZUK_ACTOR_ID, tick: 0, eventId: 10 }],
      simulationState: { ...state, npcs: [] },
    });

    expect(manager.getModelMatrix(PRIMARY_NPC_ACTOR_ID)).toBeNull();
    expect(manager.getDyingActorIds()).not.toContain(PRIMARY_NPC_ACTOR_ID);
    expect(manager['pendingAttackTriggersByActor'].has(PRIMARY_NPC_ACTOR_ID)).toBe(false);
    scene.dispose();
  });

  it('clears selected pruned corpses before syncing replacement actors', async () => {
    const { scene, draw, state } = await frameAudio();
    const manager = scene['npcInstanceManager'];
    const selected = {
      ...makeSnapshot({ id: 'old-healer', npcTypeId: 7705, position: [20, 20], size: 1 }),
      history: new Map(),
    };
    const retained = {
      ...makeSnapshot({ id: 'retained-glyph', npcTypeId: ZUK_SHIELD_NPC_ID, position: [22, 20], size: 1 }),
      history: new Map(),
    };
    draw(0, { events: [], simulationState: { ...state, npcs: [selected, retained] } });
    draw(1, {
      events: [],
      simulationState: { ...state, npcs: [selected, retained].map((npc) => ({ ...npc, alive: false })) },
    });
    draw(2, { events: [], simulationState: { ...state, npcs: [] } });
    expect(manager.getDyingActorIds()).toEqual(new Set(['old-healer', 'retained-glyph']));
    manager.updateAnimations(0, 1, [{ actorId: selected.id, trigger: 'attack', tick: 1 }]);

    draw(3, {
      events: [
        { type: 'actor_presentations_removed', npcTypeIds: [7703, 7702, 7704, 7705, 7708], tick: 0, eventId: 10 },
      ],
      simulationState: { ...state, npcs: [{ ...selected, id: 'replacement' }] },
    });

    expect(manager.getDyingActorIds()).toEqual(new Set(['retained-glyph']));
    expect(manager.getModelMatrix('old-healer')).toBeNull();
    expect(manager.getVisualPosition('replacement')).toEqual([20, 20]);
    expect(manager['pendingAttackTriggersByActor'].has(selected.id)).toBe(false);
    scene.dispose();
  });

  it.each([
    { npcTypeIds: undefined },
    { npcTypeIds: '7705' },
    { npcTypeIds: [7705, '7702'] },
    { npcTypeIds: [Number.NaN] },
  ])('ignores malformed presentation removal %j without removing corpses', async ({ npcTypeIds }) => {
    const { scene, draw, state } = await frameAudio();
    const selected = {
      ...makeSnapshot({ id: 'healer', npcTypeId: 7705, position: [20, 20], size: 1 }),
      history: new Map(),
    };
    draw(0, { events: [], simulationState: { ...state, npcs: [selected] } });
    draw(1, { events: [], simulationState: { ...state, npcs: [{ ...selected, alive: false }] } });

    draw(2, {
      events: [{ type: 'actor_presentations_removed', npcTypeIds, tick: 0, eventId: 10 }],
      simulationState: { ...state, npcs: [] },
    });

    expect(scene['npcInstanceManager'].getDyingActorIds()).toEqual(new Set(['healer']));
    scene.dispose();
  });

  it('does not dispatch historical removal events against destination presentation', async () => {
    const { scene, draw, state } = await frameAudio();
    const manager = scene['npcInstanceManager'];
    const removeActor = vi.spyOn(manager, 'removePresentation');
    const removeTypes = vi.spyOn(manager, 'removePresentationsByNpcType');
    const frames: ReplayDisplayFrame[] = [
      {
        state,
        events: [
          { type: 'actor_despawned', actorId: ZUK_ACTOR_ID, tick: 0, eventId: 10 },
          { type: 'actor_presentations_removed', npcTypeIds: [ZUK_NPC_ID], tick: 0, eventId: 11 },
        ],
      },
    ];

    draw(60, { events: [], replayHistory: { frames, throughFrameIndex: 0 } });

    expect(removeActor).not.toHaveBeenCalled();
    expect(removeTypes).not.toHaveBeenCalled();
    expect(manager.getModelMatrix(PRIMARY_NPC_ACTOR_ID)).not.toBeNull();
    scene.dispose();
  });

  it.each([
    'actor_despawned',
    'actor_presentations_removed',
  ])('preserves launched flights and pending landings when the source is removed by %s', async (type) => {
    const { scene, draw, state } = await frameAudio();
    loadEffectFixtures(scene);
    const source = {
      ...makeSnapshot({ id: 'source', npcTypeId: 7705, position: [20, 20], size: 1 }),
      history: new Map(),
    };
    const emitted: EncounterVisualEvent = {
      type: 'encounter_visual',
      tick: 0,
      eventId: 1,
      animations: [],
      projectiles: [
        {
          spotAnimId: 660,
          sourcePosition: [20, 20],
          target: { kind: 'tile', position: [25, 25] },
          startDelayCycles: 0,
          endDelayCycles: 90,
          slope: 41,
          startOffset: 0,
          startHeight: 70,
          endHeight: 0,
        },
      ],
      graphics: [{ spotAnimId: 444, target: { kind: 'tile', position: [25, 25] }, delayCycles: 10, height: 0 }],
    };
    draw(0, { events: [emitted], simulationState: { ...state, npcs: [source] } });

    const queue = draw(10, {
      events: [{ type, actorId: source.id, npcTypeIds: [7705], tick: 0, eventId: 2 }],
      simulationState: { ...state, npcs: [] },
    });

    expect(
      queue.commands.flatMap((command) =>
        command.kind === 'mesh3d' && command.meshId.startsWith('effect-') ? [command.meshId] : [],
      ),
    ).toEqual(['effect-660', 'effect-444']);
    scene.dispose();
  });

  it.each([
    { destination: 2, prior: undefined },
    { destination: 2, prior: 7 },
    { destination: 2, prior: 0 },
    { destination: 5, prior: undefined },
    { destination: 5, prior: 7 },
    { destination: 5, prior: 0 },
  ])('reconstructs emitted effects on a fresh or discontinuous seek: %j', async ({ destination, prior }) => {
    const { scene, draw, state } = await frameAudio();
    loadEffectFixtures(scene);
    const emitted: EncounterVisualEvent = {
      type: 'encounter_visual',
      tick: 0,
      eventId: 10,
      animations: [],
      projectiles: Array.from({ length: 4 }, (_, index) => ({
        spotAnimId: 660,
        sourcePosition: [20, 20],
        target: { kind: 'tile', position: [25 + index, 25] },
        startDelayCycles: 0,
        endDelayCycles: 90,
        slope: 41,
        startOffset: 0,
        startHeight: 70,
        endHeight: 0,
      })),
      graphics: [{ spotAnimId: 444, target: { kind: 'tile', position: [25, 25] }, delayCycles: 120, height: 0 }],
    };
    const frames: ReplayDisplayFrame[] = Array.from({ length: 8 }, (_, currentTick) => ({
      state: { ...state, currentTick },
      events: currentTick === 0 ? [emitted] : [],
    }));
    if (prior !== undefined) draw(prior * 30, { events: [], replayHistory: { frames, throughFrameIndex: prior } });

    const queue = draw(destination * 30, { events: [], replayHistory: { frames, throughFrameIndex: destination } });

    const effects = queue.commands.flatMap((command) =>
      command.kind === 'mesh3d' && command.meshId.startsWith('effect-') ? [command.meshId] : [],
    );
    expect(effects).toEqual(
      destination === 2 ? ['effect-660', 'effect-660', 'effect-660', 'effect-660'] : ['effect-444'],
    );
    scene.dispose();
  });

  it('reconstructs historical animation age silently on first history display and consumes only new frames thereafter', async () => {
    const { scene, draw, state, play, silentSync } = await frameAudio();
    const syncReplay = vi.spyOn(EncounterCuePlayer.prototype, 'syncReplay');
    const rebuilds = () => syncReplay.mock.calls.filter(([, , rebuild]) => rebuild).length;
    const audioEvents = new EventAudioPlayer(new AudioEngine());
    const onEvents = vi.spyOn(audioEvents, 'onEvents');
    scene.setEventAudioPlayer(audioEvents);
    const frames: ReplayDisplayFrame[] = [
      {
        state,
        events: [
          {
            type: 'encounter_visual',
            tick: 0,
            eventId: 1,
            projectiles: [],
            graphics: [],
            animations: [{ actorId: ZUK_ACTOR_ID, clipId: 'attack', delayCycles: 0 }],
          } satisfies EncounterVisualEvent,
        ],
      },
    ];
    const context = { events: [], replayHistory: { frames, throughFrameIndex: 0 } };

    draw(3, context);

    expect(silentSync).toHaveBeenCalledExactlyOnceWith(
      expect.arrayContaining([expect.objectContaining({ seqId: ZUK_SEQS.zuk.attack, currentFrame: 1 })]),
    );
    expect(play).not.toHaveBeenCalled();
    expect(onEvents).not.toHaveBeenCalled();
    draw(3, context);
    draw(5, context);
    draw(30, context);
    expect(rebuilds()).toBe(1);
    expect(play).toHaveBeenCalledWith(9002, { channel: 'sfx' }, expect.any(String));
    scene.dispose();
  });

  it('reconstructs a replacement history even when the displayed tick is unchanged', async () => {
    const { scene, draw, state } = await frameAudio();
    const syncReplay = vi.spyOn(EncounterCuePlayer.prototype, 'syncReplay');
    const rebuilds = () => syncReplay.mock.calls.filter(([, , rebuild]) => rebuild).length;
    const frames: ReplayDisplayFrame[] = [{ state, events: [] }];
    draw(0, { events: [], replayHistory: { frames, throughFrameIndex: 0 } });

    draw(0, { events: [], replayHistory: { frames: [...frames], throughFrameIndex: 0 } });

    expect(rebuilds()).toBe(2);
    scene.dispose();
  });

  it('forwards the generic audio services when provided', () => {
    const eventAudioPlayer = new EventAudioPlayer(new AudioEngine());
    const frameSoundTracker = new FrameSoundTracker(new AudioEngine());
    const setEventAudioPlayer = vi.spyOn(InfernoSceneCompositor.prototype, 'setEventAudioPlayer');
    const setFrameSoundTracker = vi.spyOn(InfernoSceneCompositor.prototype, 'setFrameSoundTracker');

    createZukSceneBuilder({ eventAudioPlayer, frameSoundTracker });

    expect(setEventAudioPlayer).toHaveBeenCalledExactlyOnceWith(eventAudioPlayer);
    expect(setFrameSoundTracker).toHaveBeenCalledExactlyOnceWith(frameSoundTracker);
  });

  it.each([undefined, {}])('forwards null audio services when options are %j', (options) => {
    const setEventAudioPlayer = vi.spyOn(InfernoSceneCompositor.prototype, 'setEventAudioPlayer');
    const setFrameSoundTracker = vi.spyOn(InfernoSceneCompositor.prototype, 'setFrameSoundTracker');

    createZukSceneBuilder(options);

    expect(setEventAudioPlayer).toHaveBeenCalledExactlyOnceWith(null);
    expect(setFrameSoundTracker).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('plays cache frame sounds from the current built pose and listener position', async () => {
    const { scene, draw, play, update } = await frameAudio();
    draw(0);
    play.mockClear();

    draw(3);

    expect(play).toHaveBeenCalledExactlyOnceWith(9001, { channel: 'sfx' }, expect.any(String));
    expect(update).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ actorId: PRIMARY_NPC_ACTOR_ID, seqId: ZUK_SEQS.zuk.attack, currentFrame: 1 }),
      ]),
      [31.5, 44.5],
    );
    scene.dispose();
  });

  it.each([
    { timeline: { timelineKey: 'live', paused: true } },
    { timeline: undefined, replayPaused: true },
  ])('silently synchronizes paused frames and resumes without replaying them: %j', async (paused) => {
    const { scene, draw, play, silentSync } = await frameAudio();
    draw(0, paused);
    draw(3, paused);

    draw(5);

    expect(silentSync).toHaveBeenCalledTimes(2);
    expect(play).toHaveBeenCalledExactlyOnceWith(9002, { channel: 'sfx' }, expect.any(String));
    scene.dispose();
  });

  it.each([
    { cycle: 0, overrides: {} },
    { cycle: 90, overrides: {} },
    { cycle: 31, overrides: { timeline: { timelineKey: 'replay', paused: false } } },
  ])('resets and silently synchronizes a timeline discontinuity: %j', async ({ cycle, overrides }) => {
    const { scene, draw, play, update, silentSync, reset } = await frameAudio();
    draw(30);
    play.mockClear();
    update.mockClear();

    draw(cycle, overrides);

    expect(reset).toHaveBeenCalledOnce();
    expect(silentSync).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    scene.dispose();
  });

  it('clears tracker state when the scene resets', async () => {
    const { scene, draw, tracker, reset } = await frameAudio();
    draw(0);

    scene.resetIntroState();

    expect(reset).toHaveBeenCalledOnce();
    expect(tracker['state'].size).toBe(0);
    scene.dispose();
  });

  it('detaches the tracker when disposed so later builds and resets cannot use it', async () => {
    const { scene, draw, update, silentSync, reset } = await frameAudio();
    draw(0);
    scene.dispose();
    update.mockClear();
    silentSync.mockClear();
    reset.mockClear();

    const queue = draw(3);
    scene.resetIntroState();

    expect(queue.commands).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
    expect(silentSync).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it('returns the compositor with the complete scene interface before assets load', () => {
    const builder = createZukSceneBuilder();

    expect(builder).toBeInstanceOf(InfernoSceneCompositor);
    expect(builder.isNpcLoaded()).toBe(false);
    for (const method of [
      'build',
      'loadTerrain',
      'loadNpc',
      'loadNpcType',
      'loadPlayer',
      'loadSpotAnims',
      'loadLocs',
      'getTerrainHeights',
      'getAllNpcHitTestData',
      'getAllGroundItemHitTestData',
      'setSmoothTerrain',
      'isNpcTypeLoaded',
      'resetIntroState',
      'dispose',
    ]) {
      expect(Reflect.get(builder, method)).toBeTypeOf('function');
    }
  });

  it('resolves the retained terrain block from the descriptor without forcing a Zuk death duration', () => {
    const resolved = getEncounterRenderConfig('inferno');
    expect(resolved?.terrainMapSquare).toEqual(ZUK_MAP_SQUARE);
    // The scene draws all five squares; the arena, and so the actor height grid, is the origin alone.
    expect(resolved?.mapSquareOffsets).toEqual(ZUK_MAP_SQUARE_OFFSETS.map(({ dx, dy }) => ({ dx, dy })));
    expect(resolved?.arenaMapSquareOffsets).toEqual([{ dx: 0, dy: 0 }]);
    // Zuk is no primary NPC any more; his death clip is his preload's, with no forced duration.
    const zuk = INFERNO_RENDER_CONFIG.preloadNpcTypes?.find((type) => type.npcTypeId === ZUK_NPC_ID);
    expect(zuk).toMatchObject({ deathSeqId: ZUK_SEQS.zuk.death, bossDeathAnimationEnabled: true });
    expect(zuk).not.toHaveProperty('deathDurationMs');
  });

  it('loads primary idle and attack clips with all retained NPC models and a cache-owned death duration', async () => {
    const scene = new SceneProbe();
    scene.setEncounterRenderConfig(ZUK_PRIMARY_RENDER_CONFIG);
    const { loader, animation, loadSequence } = assets();

    await scene.loadNpc(loader, animation);

    expect(scene.isNpcLoaded()).toBe(true);
    expect(loadSequence).toHaveBeenCalledWith(ZUK_SEQS.zuk.idle);
    expect(loadSequence).toHaveBeenCalledWith(ZUK_SEQS.zuk.attack);
    expect(scene.manager['typeRegistry'].get(ZUK_NPC_ID)?.deathDurationMs).toBeNull();
    for (const type of ZUK_PRIMARY_RENDER_CONFIG.preloadNpcTypes ?? [])
      expect(scene.isNpcTypeLoaded(type.npcTypeId)).toBe(true);
    scene.dispose();
  });

  it.each([
    { encounter: 'Inferno without a primary NPC', config: INFERNO_RENDER_CONFIG, renderId: ZUK_ACTOR_ID },
    { encounter: 'primary-NPC fixture', config: ZUK_PRIMARY_RENDER_CONFIG, renderId: PRIMARY_NPC_ACTOR_ID },
  ])('uses real Zuk overlay heights in the $encounter', async ({ config, renderId }) => {
    const scene = new SceneProbe();
    scene.setEncounterRenderConfig(config);
    const { loader, animation } = assets();
    try {
      await scene.loadNpc(loader, animation);
      const zuk = makeSnapshot({ id: ZUK_ACTOR_ID, npcTypeId: ZUK_NPC_ID, role: 'boss', position: [28, 52], size: 7 });
      scene.sync([zuk]);

      const heights = scene.manager.getNpcOverlayHeights(renderId);
      expect(heights).not.toBeNull();
      expect(heights?.healthBarWidth).toBeGreaterThan(40);
      expect(heights?.healthBarHeight).not.toBe(1.5);
      expect(scene['buildNpcOverlayHeightsMap']([zuk])).toEqual(new Map([[ZUK_ACTOR_ID, heights]]));
    } finally {
      scene.dispose();
    }
  });

  it.each([
    { id: 'healer', npcTypeId: 7705, role: 'minion', duration: 1800, pinned: false },
    { id: 'ordinary', npcTypeId: ZUK_SHIELD_NPC_ID, role: 'npc', duration: 200, pinned: false },
    { id: 'void-flare', npcTypeId: 14179, role: 'minion', duration: 200, pinned: true },
    { id: ZUK_ACTOR_ID, npcTypeId: ZUK_NPC_ID, role: 'boss', duration: 200, pinned: false },
  ] satisfies {
    id: string;
    npcTypeId: number;
    role: NpcSnapshot['role'];
    duration: number;
    pinned: boolean;
  }[])('removes attached overlays with the rendered corpse for $id', async ({
    id,
    npcTypeId,
    role,
    duration,
    pinned,
  }) => {
    const { scene, state, draw } = safeScene('3d');
    const { loader, animation } = assets();
    await scene.loadNpc(loader, animation);
    const preload = YAMA_ENCOUNTER_RENDER_CONFIG.preloadNpcTypes?.find((type) => type.npcTypeId === npcTypeId);
    if (preload) await scene.loadNpcType(npcTypeId, loader, animation, preload);
    const npc: NpcState = {
      ...makeSnapshot({ id, npcTypeId, role, position: [30, 40], size: 1 }),
      ...(pinned ? { alwaysShowHealthBar: true } : {}),
      history: new Map(),
    };
    const dead = { ...npc, alive: false, hp: 0 };
    const simulationState = { ...state, npcs: [dead] };
    const events: RenderContext['events'] = [
      { type: 'hitsplat_spawned', eventId: 1, tick: 0, targetId: id, amount: 10, hitsplatType: 'damage' },
      {
        type: 'overhead_text',
        eventId: 2,
        tick: 0,
        anchor: { actorId: id },
        overheadText: 'Farewell',
        overheadCycle: 8,
      },
    ];
    const aliveWithoutHits = draw({ simulationState: { ...state, npcs: [npc] }, interpolatedTick: 0 });
    const dyingWithoutHits = draw({ simulationState, interpolatedTick: 0 });
    const alwaysOnKeys = pinned ? [`npc-healthbar-${id}`] : [];
    expect((aliveWithoutHits.healthBars ?? []).map((bar) => bar.key)).toEqual(alwaysOnKeys);
    expect((dyingWithoutHits.healthBars ?? []).map((bar) => bar.key)).toEqual(alwaysOnKeys);
    const visible = draw({ simulationState, events, interpolatedTick: 0 });
    expect(visible.healthBars?.map((bar) => bar.key)).toContain(`npc-healthbar-${id}`);
    expect(visible.hitsplats?.map((splat) => splat.key)).toContain(`hitsplat-${id}-slot-0`);
    expect(visible.overheadTexts).toHaveLength(1);

    scene.manager.updateAnimations(duration, 1, []);
    const expired = draw({ simulationState, events: [], interpolatedTick: 0 });

    expect(scene.manager.getDyingActorIds().size).toBe(0);
    expect.soft(expired.healthBars ?? []).toHaveLength(0);
    expect.soft(expired.hitsplats ?? []).toHaveLength(0);
    expect.soft(expired.overheadTexts ?? []).toHaveLength(0);
    scene.dispose();
  });

  it.each(['2d', '3d'] as const)('preserves live NPC overlay fallbacks without assets in %s', (renderMode) => {
    const { scene, state, context, draw } = safeScene(renderMode);
    const npc = makeSnapshot({ id: 'unloaded', npcTypeId: 7705, position: [30, 40], size: 1 });
    const queue = draw({
      simulationState: {
        ...state,
        npcs: [
          {
            ...npc,
            history: new Map(),
            spawnTick: 0,
            despawnTick: 10,
            attackTimer: { nextAttackTick: 4, attackSpeed: 4 },
          },
        ],
      },
      options: { ...context.options, showNpcAttackTimerMetronome: true },
      events: [
        { type: 'hitsplat_spawned', eventId: 1, tick: 0, targetId: npc.id, amount: 10, hitsplatType: 'damage' },
        {
          type: 'overhead_text',
          eventId: 2,
          tick: 0,
          anchor: { actorId: npc.id },
          overheadText: 'Ready',
          overheadCycle: 8,
        },
      ],
    });
    expect(queue.healthBars).toHaveLength(1);
    expect(queue.hitsplats).toHaveLength(1);
    expect(queue.overheadTexts).toHaveLength(1);
    expect(queue.timerBars?.map((bar) => bar.key)).toEqual(['npc-timerbar-unloaded', 'npc-attack-timer-unloaded']);
    scene.dispose();
  });

  it('preserves dead NPC snapshot overlays in 2d without a model lifecycle', () => {
    const { scene, state, draw } = safeScene('2d');
    const npc = {
      ...makeSnapshot({ id: 'corpse', npcTypeId: 7705, position: [30, 40], size: 1, alive: false }),
      history: new Map(),
    };
    const queue = draw({
      simulationState: { ...state, npcs: [npc] },
      events: [
        { type: 'hitsplat_spawned', eventId: 1, tick: 0, targetId: npc.id, amount: 10, hitsplatType: 'damage' },
        {
          type: 'overhead_text',
          eventId: 2,
          tick: 0,
          anchor: { actorId: npc.id },
          overheadText: 'Farewell',
          overheadCycle: 8,
        },
      ],
    });
    expect(queue.healthBars).toHaveLength(1);
    expect(queue.hitsplats).toHaveLength(1);
    expect(queue.overheadTexts).toHaveLength(1);
    scene.dispose();
  });

  it.each([119, 120])('matches attached overlays to the reconstructed healer corpse at cycle %s', async (cycle) => {
    const { scene, state, draw } = await frameAudio();
    const alive = {
      ...makeSnapshot({ id: 'healer', npcTypeId: 7705, position: [30, 40], size: 1 }),
      history: new Map(),
      spawnTick: 0,
    };
    const dead = { ...alive, alive: false, hp: 0, despawnTick: 1 };
    const destination = { ...state, currentTick: Math.floor(cycle / 30), npcs: [dead] };
    const frames: ReplayDisplayFrame[] = [
      { state: { ...state, npcs: [alive] }, events: [] },
      {
        state: { ...state, currentTick: 1, npcs: [dead] },
        events: [
          { type: 'hitsplat_spawned', eventId: 1, tick: 1, targetId: dead.id, amount: 10, hitsplatType: 'damage' },
          {
            type: 'overhead_text',
            eventId: 2,
            tick: 1,
            anchor: { actorId: dead.id },
            overheadText: 'Farewell',
            overheadCycle: 8,
          },
        ],
      },
      { state: destination, events: [] },
    ];

    const queue = draw(cycle, {
      simulationState: destination,
      events: frames.flatMap((frame) => frame.events),
      replayHistory: { frames, throughFrameIndex: 2 },
    });

    const visible = cycle < 120;
    expect(scene['npcInstanceManager'].getDyingActorIds().has(dead.id)).toBe(visible);
    expect.soft(queue.healthBars ?? []).toHaveLength(visible ? 1 : 0);
    expect.soft(queue.overheadTexts ?? []).toHaveLength(visible ? 1 : 0);
    scene.dispose();
  });

  it('caps the Yt-HurKot corpse at its true death-animation length', async () => {
    const entry = ZUK_PRIMARY_RENDER_CONFIG.preloadNpcTypes?.find((type) => type.npcTypeId === 7705);
    // Seq 2638 holds its last frame for 20000 of 20090 cycles; only the first 90 cycles
    // (1.8 s) are played animation (docs/encounters/zuk-facts-spec.md section 9).
    expect(entry?.deathDurationMs).toBe(1800);
    const scene = new SceneProbe();
    scene.setEncounterRenderConfig(ZUK_PRIMARY_RENDER_CONFIG);
    const { loader, animation, loadSequence } = assets();
    const deathSequence = new SeqType(2638, cacheInfo);
    deathSequence.frameIds = [10, 11];
    deathSequence.frameLengths = [90, 20000];
    const loadOtherSequence = loadSequence.getMockImplementation();
    loadSequence.mockImplementation((id) => (id === 2638 ? deathSequence : loadOtherSequence?.(id)));

    await scene.loadNpc(loader, animation);

    expect(scene.manager['typeRegistry'].get(7705)?.deathDurationMs).toBe(1800);
    const healer = makeSnapshot({ id: 'healer', npcTypeId: 7705, position: [30, 40], size: 1 });
    const deadHealer = { ...healer, alive: false, history: new Map<number, [number, number]>() };
    scene.sync([healer]);
    scene.sync([deadHealer]);
    scene.animate({ currentTick: 0, npcs: [deadHealer] }, 0);
    scene.animate({ currentTick: 2, npcs: [deadHealer] }, 89 / 30);
    expect(scene.manager.getDyingActorIds().has(healer.id)).toBe(true);

    scene.animate({ currentTick: 3, npcs: [deadHealer] }, 3);
    scene.sync([deadHealer]);
    expect(scene.manager.getInstanceFrameStates().some(({ actorId }) => actorId === healer.id)).toBe(false);

    scene.manager.reconstructDyingInstance(deadHealer, 1800);
    expect(scene.manager.getInstanceFrameStates().some(({ actorId }) => actorId === healer.id)).toBe(false);
    scene.dispose();
  });

  it('remaps the primary snapshot rather than drawing a duplicate boss', async () => {
    const scene = new SceneProbe();
    scene.setEncounterRenderConfig(ZUK_PRIMARY_RENDER_CONFIG);
    const { loader, animation } = assets();
    await scene.loadNpc(loader, animation);

    scene.sync([
      makeSnapshot({ id: ZUK_ACTOR_ID, position: [28, 52], npcTypeId: ZUK_NPC_ID, size: 7 }),
      makeSnapshot({ id: 'glyph', position: [30, 47], npcTypeId: ZUK_SHIELD_NPC_ID, size: 1 }),
    ]);

    expect(
      scene
        .getAllNpcHitTestData()
        .map((entry) => entry.actorId)
        .sort(),
    ).toEqual(['glyph', PRIMARY_NPC_ACTOR_ID]);
    scene.dispose();
  });

  it('triggers only explicit clips on the primary alias at their delayed client cycle and holds a paused clock', async () => {
    const scene = new SceneProbe();
    scene.setEncounterRenderConfig(ZUK_PRIMARY_RENDER_CONFIG);
    const { loader, animation } = assets();
    await scene.loadNpc(loader, animation);
    const state = {
      currentTick: 0,
      npcs: [
        {
          ...makeSnapshot({ id: ZUK_ACTOR_ID, position: [28, 52], npcTypeId: ZUK_NPC_ID, size: 7 }),
          history: new Map(),
        },
      ],
    };
    scene.sync(state.npcs);
    scene.events([
      {
        type: 'encounter_visual',
        tick: 0,
        eventId: 1,
        projectiles: [],
        graphics: [],
        animations: [{ actorId: ZUK_ACTOR_ID, clipId: 'attack', delayCycles: 5 }],
      },
    ]);
    scene.animate(state, 0);
    scene.animate(state, 4 / 30);
    const before = scene.manager.getInstanceFrameStates()[0]?.animController?.getFrameState();

    scene.animate(state, 8 / 30);
    const active = scene.manager.getInstanceFrameStates()[0]?.animController?.getFrameState();
    scene.animate(state, 8 / 30);
    const held = scene.manager.getInstanceFrameStates()[0]?.animController?.getFrameState();

    expect(before?.seqId).toBe(ZUK_SEQS.zuk.idle);
    expect(active?.seqId).toBe(ZUK_SEQS.zuk.attack);
    expect(active?.currentFrameIndex).toBe(1);
    expect(held).toEqual(active);
    scene.animate(state, 15 / 30);
    expect(scene.manager.getInstanceFrameStates()[0]?.animController?.getFrameState()?.seqId).toBe(ZUK_SEQS.zuk.idle);
    scene.resetIntroState();
    scene.events([
      {
        type: 'encounter_visual',
        tick: 0,
        eventId: 1,
        projectiles: [],
        graphics: [],
        animations: [{ actorId: ZUK_ACTOR_ID, clipId: 'attack', delayCycles: 0 }],
      },
    ]);
    scene.animate(state, 0);
    expect(scene.manager.getInstanceFrameStates()[0]?.animController?.getFrameState()?.seqId).toBe(ZUK_SEQS.zuk.attack);
    scene.dispose();
  });
});

describe('Inferno scene (no primary NPC)', () => {
  const ids = INFERNO_WAVE_NPC_IDS;
  const npc = (id: string, npcTypeId: number, overrides: Partial<NpcState> = {}): NpcState => ({
    ...makeSnapshot({ id, npcTypeId, position: [20, 20], size: 1 }),
    history: new Map(),
    spawnTick: 0,
    ...overrides,
  });

  async function wavesScene() {
    const scene = createZukSceneBuilder({ encounterRenderConfig: INFERNO_RENDER_CONFIG });
    if (!(scene instanceof InfernoSceneCompositor)) expect.fail('Expected Inferno compositor');
    const { loader, animation } = assets();
    await scene.loadNpc(loader, animation);
    const state = new SimulationEngine({ encounter: createZukWaveEncounter(1), combatSeed: 1 }).getState();
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
    return { scene, manager, draw, pose, state };
  }

  /** Each NPC mesh command's owning actor, once per drawn command (opaque and transparent halves). */
  function drawnActors(queue: RenderQueue): string[] {
    return queue.commands.flatMap((command) => {
      const match = command.kind === 'mesh3d' ? /^npc-\d+-opaque-(.+)$/.exec(command.meshId) : null;
      return match ? [match[1]!] : [];
    });
  }

  it('animates NPCs synced before their types load, once loadNpc hands over the animation system', async () => {
    const scene = createZukSceneBuilder({ encounterRenderConfig: INFERNO_RENDER_CONFIG });
    if (!(scene instanceof InfernoSceneCompositor)) expect.fail('Expected Inferno compositor');
    const manager = scene['npcInstanceManager'];
    const state = new SimulationEngine({ encounter: createZukWaveEncounter(1), combatSeed: 1 }).getState();
    const nibbler = npc('nib', ids.nibbler);
    const draw = (cycle: number) =>
      scene.build(
        {
          simulationState: { ...state, currentTick: Math.floor(cycle / 30), npcs: [nibbler] },
          interpolatedTick: cycle / 30,
          speedMultiplier: 1,
          interaction: { hoveredTile: null, targetTile: null },
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
        },
        {
          tileToScreen: (tile) => tile,
          tileDeltaToScreen: (tile) => tile,
          screenToTile: () => null,
          tilePolygonScreen: (tile) => [tile, tile, tile, tile],
        },
        { width: 800, height: 600, dpr: 1 },
      );

    // The viewport calls `loadNpc` only while this is false; it is the call that sets the
    // animation system the player and spot anims use.
    expect(scene.isNpcLoaded()).toBe(false);
    draw(30);
    expect(manager['instanceRegistry'].size).toBe(0);

    const { loader, animation } = assets();
    const loading = scene.loadNpc(loader, animation);
    expect(scene['playerAnimationSystem']).toBe(animation);
    await loading;
    expect(scene.isNpcLoaded()).toBe(true);

    draw(31);
    const frame = () => manager['instanceRegistry'].get('nib')?.animController?.getFrameState();
    expect(frame()).toMatchObject({ seqId: INFERNO_WAVE_SEQS.nibbler.idle, currentFrameIndex: 0 });
    draw(34);
    expect(frame()).toMatchObject({ seqId: INFERNO_WAVE_SEQS.nibbler.idle, currentFrameIndex: 1 });
    scene.dispose();
  });

  it('declares no primary NPC and preloads every wave species', () => {
    expect(INFERNO_RENDER_CONFIG.primaryNpc).toBeUndefined();
    const configured = new Set(INFERNO_RENDER_CONFIG.preloadNpcTypes?.map((type) => type.npcTypeId));
    for (const npcTypeId of Object.values(ids)) expect(configured.has(npcTypeId)).toBe(true);
  });

  it('creates, moves and animates an instance per wave NPC through the compositor, drawing each once', async () => {
    const { scene, manager, draw, pose } = await wavesScene();
    const nibbler = npc('nib', ids.nibbler);
    const bat = npc('bat', ids.bat, { position: [25, 20], previousPosition: [24, 20] });

    const first = draw(30, [nibbler, bat]);
    expect([...manager['instanceRegistry'].keys()].sort()).toEqual(['bat', 'nib']);
    expect(drawnActors(first).sort()).toEqual(['bat', 'nib']);
    expect(pose('nib')).toMatchObject({ seqId: INFERNO_WAVE_SEQS.nibbler.idle, currentFrameIndex: 0 });
    expect(pose('bat')?.seqId).toBe(INFERNO_WAVE_SEQS.bat.idle);

    draw(34, [nibbler, bat]);
    expect(pose('nib')).toMatchObject({ seqId: INFERNO_WAVE_SEQS.nibbler.idle, currentFrameIndex: 1 });

    // Halfway through the bat's step east; the matrix carries the footprint center.
    draw(45, [nibbler, bat]);
    expect(manager['instanceRegistry'].get('bat')?.currentModelMatrix[12]).toBeCloseTo(24.5 + 0.5);
    expect(manager['instanceRegistry'].get('nib')?.currentModelMatrix[12]).toBeCloseTo(20.5);

    const cue: EncounterVisualEvent = {
      type: 'encounter_visual',
      eventId: 1,
      tick: 2,
      projectiles: [],
      graphics: [],
      animations: [{ actorId: 'nib', clipId: 'attack', delayCycles: 0 }],
    };
    draw(60, [nibbler, bat], { events: [cue] });
    expect(pose('nib')?.seqId).toBe(INFERNO_WAVE_SEQS.nibbler.attack);
    expect(pose('bat')?.seqId).toBe(INFERNO_WAVE_SEQS.bat.idle);

    // A removed NPC loses its instance.
    expect(drawnActors(draw(61, [nibbler]))).toEqual(['nib']);
    scene.dispose();
  });

  describe('wave 69 intro after wave 68', () => {
    const C = 40;
    const ADD = C - 8;
    const zuk = npc(ZUK_ACTOR_ID, ZUK_NPC_ID, { position: [28, 52], size: 7, spawnTick: C });
    const rise: EncounterVisualEvent = {
      type: 'encounter_visual',
      eventId: 1,
      tick: ADD,
      projectiles: [],
      graphics: [],
      animations: [{ actorId: ZUK_ACTOR_ID, clipId: ZUK_INTRO_RISE_CLIP, delayCycles: 0 }],
    };
    const atControl = (state: SimulationState, controlTick: number, tick: number): SimulationState => {
      if (state.encounter.kind !== 'inferno') expect.fail('Expected an Inferno snapshot');
      return {
        ...state,
        currentTick: tick,
        npcs: [zuk],
        encounter: { ...state.encounter, visuals: { ...state.encounter.visuals, zukControlTick: controlTick } },
      };
    };

    it('raises Zuk at the add, live and on a replay seek, though his spawn tick is control C', async () => {
      // The test clip is 10 cycles (frames of 2, 3, 5): 4 cycles in is its second frame.
      const live = await wavesScene();
      const added = atControl(live.state, C, ADD);
      live.draw(ADD * 30, [zuk], { simulationState: added, events: [rise] });
      live.draw(ADD * 30 + 4, [zuk], { simulationState: added, events: [rise] });
      expect(live.pose(ZUK_ACTOR_ID)).toMatchObject({ seqId: ZUK_SEQS.zuk.spawn, currentFrameIndex: 1 });
      live.scene.dispose();

      const seek = await wavesScene();
      // A seek reconstructs only once the scene's graphics have loaded.
      loadEffectFixtures(seek.scene, INFERNO_RENDER_CONFIG.spotAnimIds);
      const frames: ReplayDisplayFrame[] = [{ state: atControl(seek.state, C, ADD), events: [rise] }];
      seek.draw(ADD * 30 + 4, [zuk], {
        simulationState: frames[0]!.state,
        replayHistory: { frames, throughFrameIndex: 0 },
      });
      expect(seek.pose(ZUK_ACTOR_ID)).toMatchObject({ seqId: ZUK_SEQS.zuk.spawn, currentFrameIndex: 1 });
      seek.scene.dispose();
    });

    it('holds the captured view and fade from the snapshot alone, and none on a wave-69 start', async () => {
      const { scene, state } = await wavesScene();
      const frame = scene.getCutsceneFrame(atControl(state, C, C - 5), C - 5);
      expect(frame?.fadeOpacity).toBe(0);
      // Flat test ground (no terrain): heights are OSRS units over 128, shaken by a few units.
      expect(frame?.camera?.lookAt).toEqual({ x: 28.5, y: 56.5, z: 140 / 128 });
      expect(frame?.camera?.eye.x).toBeCloseTo(35.5, 1);
      expect(frame?.camera?.eye.y).toBeCloseTo(35.5, 1);
      expect(frame?.camera?.eye.z).toBeCloseTo(1000 / 128, 1);
      expect(scene.getCutsceneFrame(atControl(state, C, C - 11), C - 11)).toEqual({ fadeOpacity: 1, camera: null });
      expect(scene.getCutsceneFrame(atControl(state, C, C), C)).toBeNull();
      expect(scene.getCutsceneFrame(atControl(state, 0, 0), 0.5)).toBeNull();
      scene.dispose();
    });
  });

  it('plays a wave death live and reconciles a corpse first seen after its death', async () => {
    const live = await wavesScene();
    const alive = npc('nib', ids.nibbler);
    const dead = { ...alive, alive: false, hp: 0, despawnTick: 2 };
    live.draw(30, [alive]);
    live.draw(59, [alive]);
    const dying = live.draw(60, [dead]);
    expect(live.manager.getDyingActorIds().has('nib')).toBe(true);
    expect(live.manager['instanceRegistry'].has('nib')).toBe(false);
    expect(drawnActors(dying)).toEqual(['nib']);
    expect(live.pose('nib')?.seqId).toBe(INFERNO_WAVE_SEQS.nibbler.death);
    live.scene.dispose();

    // First seen one tick after its death (a seek, or a scene opened mid-fight): the corpse is
    // rebuilt at its age rather than skipped or restarted. The mock death clip lasts 60 cycles here.
    const seek = await wavesScene();
    const deathSequence = new SeqType(INFERNO_WAVE_SEQS.nibbler.death, cacheInfo);
    deathSequence.frameIds = [10, 11, 12];
    deathSequence.frameLengths = [20, 20, 20];
    seek.manager['typeRegistry'].get(ids.nibbler)!.animationSet!.death = {
      kind: 'frame',
      id: 'death',
      seqId: deathSequence.id,
      seqType: deathSequence,
      frameIds: deathSequence.frameIds,
      frameLengths: deathSequence.frameLengths,
    };
    seek.draw(90, [{ ...dead, despawnTick: 2 }], { timeline: { timelineKey: 'live', paused: true } });
    expect(seek.manager['dyingInstances'].get('nib')?.deathTimerMs).toBeCloseTo(600);
    expect(seek.pose('nib')).toMatchObject({ seqId: INFERNO_WAVE_SEQS.nibbler.death, currentFrameIndex: 1 });
    seek.scene.dispose();
  });

  // The mock death clips last 10 cycles; the encounter removes a blob 2 ticks and a ranger 4 ticks
  // after the death starts, so without the hold both corpses vanished well before their removal.
  it.each([
    { name: 'blob', npcTypeId: ids.blob, death: INFERNO_WAVE_SEQS.blob.death, heldTicks: 1.75 },
    { name: 'ranger', npcTypeId: ids.ranger, death: ZUK_SEQS.ranger.death, heldTicks: 3.5 },
  ])('holds a $name corpse on its last death frame until the encounter removes it', async ({
    npcTypeId,
    death,
    heldTicks,
  }) => {
    const alive = npc('corpse', npcTypeId);
    const dead = { ...alive, alive: false, hp: 0, despawnTick: 2 };
    const heldCycle = (2 + heldTicks) * 30;

    const live = await wavesScene();
    live.draw(59, [alive]);
    live.draw(60, [dead]);
    for (let cycle = 61; cycle <= heldCycle; cycle += 7) live.draw(cycle, [dead]);
    expect(drawnActors(live.draw(heldCycle, [dead]))).toEqual(['corpse']);
    expect(live.pose('corpse')).toMatchObject({ seqId: death, currentFrameIndex: 2 });
    // Removed from the snapshot: the corpse goes with it.
    expect(drawnActors(live.draw(heldCycle + 1, []))).toEqual([]);
    expect(live.manager.getDyingActorIds().size).toBe(0);
    live.scene.dispose();

    // A seek into the same window rebuilds the held frame; one past the removal shows nothing.
    const seek = await wavesScene();
    const paused = { timeline: { timelineKey: 'live', paused: true } } as const;
    expect(drawnActors(seek.draw(heldCycle, [dead], paused))).toEqual(['corpse']);
    expect(seek.pose('corpse')).toMatchObject({ seqId: death, currentFrameIndex: 2 });
    seek.scene.dispose();
  });

  it('still ends a corpse the encounter keeps (a Yt-HurKot awaiting its Jad) after its death clip', async () => {
    const live = await wavesScene();
    const alive = npc('healer', ids.jad_healer);
    const dead = { ...alive, alive: false, hp: 0, despawnTick: 2 };
    live.draw(59, [alive]);
    live.draw(60, [dead]);
    // Its configured 1800 ms (90-cycle) corpse retention, not the snapshot, ends it.
    for (let cycle = 61; cycle <= 145; cycle += 6) live.draw(cycle, [dead]);
    expect(live.manager.getDyingActorIds().has('healer')).toBe(true);
    live.draw(150, [dead]);
    expect(live.manager.getDyingActorIds().has('healer')).toBe(false);
    expect(drawnActors(live.draw(151, [dead]))).toEqual([]);
    live.scene.dispose();
  });

  it('plays the idle-less pillar collapse from its spawn tick and holds its last frame', async () => {
    const collapse = npc('collapse', INFERNO_WAVE_NPC_IDS.pillarCollapse, { spawnTick: 2 });
    const live = await wavesScene();
    live.draw(60, [collapse]);
    expect(live.pose('collapse')).toMatchObject({ seqId: INFERNO_WAVE_SEQS.pillarCollapse, currentFrameIndex: 0 });
    live.draw(62, [collapse]);
    expect(live.pose('collapse')).toMatchObject({ seqId: INFERNO_WAVE_SEQS.pillarCollapse, currentFrameIndex: 1 });
    // The mock clip lasts 10 cycles: past it the rubble frame holds rather than restarting or standing.
    for (const cycle of [70, 80, 89]) {
      live.draw(cycle, [collapse]);
      expect(live.pose('collapse')).toMatchObject({ seqId: INFERNO_WAVE_SEQS.pillarCollapse, currentFrameIndex: 2 });
    }
    live.scene.dispose();

    const late = await wavesScene();
    late.draw(64, [collapse]);
    expect(late.pose('collapse')).toMatchObject({ seqId: INFERNO_WAVE_SEQS.pillarCollapse, currentFrameIndex: 1 });
    late.scene.dispose();
  });

  it('preloads and gates on every Inferno graphic, the waves’ and wave 69’s', async () => {
    const waves = createZukSceneBuilder({ encounterRenderConfig: INFERNO_RENDER_CONFIG });
    const zuk = createZukSceneBuilder({ encounterRenderConfig: ZUK_PRIMARY_RENDER_CONFIG });
    if (!(waves instanceof InfernoSceneCompositor) || !(zuk instanceof InfernoSceneCompositor))
      expect.fail('Expected Inferno compositors');
    const loader = {} as Parameters<InfernoSceneCompositor['loadSpotAnims']>[0];
    const loaded = new Set<number>();
    const preloaded = new Map<InfernoSceneCompositor, number[]>();
    for (const scene of [waves, zuk]) {
      vi.spyOn(scene['spotAnimRenderer'], 'preload').mockImplementation((_loader, spotAnimIds) => {
        preloaded.set(scene, spotAnimIds);
      });
      vi.spyOn(scene['spotAnimRenderer'], 'isLoaded').mockImplementation((id) => loaded.has(id));
      await scene['loadEncounterSpotAnims'](loader);
    }

    expect(preloaded.get(waves)).toEqual([...new Set([...INFERNO_WAVE_SPOT_ANIM_IDS, ...INFERNO_SPOT_ANIM_IDS])]);
    expect(preloaded.get(zuk)).toEqual([...INFERNO_SPOT_ANIM_IDS]);
    for (const id of INFERNO_SPOT_ANIM_IDS) loaded.add(id);
    expect(zuk['isEncounterSpotAnimsLoaded']()).toBe(true);
    expect(waves['isEncounterSpotAnimsLoaded']()).toBe(false);
    for (const id of INFERNO_WAVE_SPOT_ANIM_IDS) loaded.add(id);
    expect(waves['isEncounterSpotAnimsLoaded']()).toBe(true);
    waves.dispose();
    zuk.dispose();
  });
});

/**
 * Characterization of a recording in the old `inferno_visual` wire shape (`legacyInfernoRecording`),
 * drawn by the shipped Inferno scene. Observed only through the render queue and NPC poses, so this
 * block is meant to pass unchanged through every commit of the encounter-cue migration: continuous
 * playback and a direct seek must agree with each other and with these values.
 *
 * Free-running idle phase is not compared; a seek does not restore it
 * (docs/architecture/replay-timeline-discontinuity.md, Limits).
 */
describe('legacy inferno_visual recording: continuous playback versus direct seek', () => {
  // Built inside the tests: constructing the engine sets the global arena, which `afterEach` resets.
  let recorded: readonly ReplayDisplayFrame[] | undefined;
  const legacyFrames = () => {
    recorded ??= legacyInfernoRecording().frames;
    return recorded;
  };
  const idleSeqIds = new Set(INFERNO_RENDER_CONFIG.preloadNpcTypes?.flatMap(({ idleSeqId }) => idleSeqId ?? []));
  const sizes = new Map<number, number>(
    [LEGACY_INFERNO.nibbler, LEGACY_INFERNO.mager, LEGACY_INFERNO.healer, LEGACY_INFERNO.zuk].map(
      ({ npcTypeId, size }) => [npcTypeId, size],
    ),
  );
  const scenes: SceneCompositor[] = [];
  afterEach(() => {
    for (const scene of scenes.splice(0)) scene.dispose();
  });

  async function legacyScene() {
    const scene = createZukSceneBuilder({ encounterRenderConfig: INFERNO_RENDER_CONFIG });
    if (!(scene instanceof SceneCompositor)) expect.fail('Expected a scene compositor');
    scenes.push(scene);
    const { loader, animation } = syntheticNpcAssets((id) => sizes.get(id) ?? 1);
    await scene.loadNpc(loader, animation);
    installSyntheticSpotAnims(scene, INFERNO_RENDER_CONFIG.spotAnimIds ?? []);
    const context = {
      speedMultiplier: 1,
      interaction: { hoveredTile: null, targetTile: null },
      options: SCENE_OPTIONS,
    };
    const at = (cycle: number, paused = false) =>
      observeScene(
        scene,
        scene.build({ ...context, ...replayContextAt(legacyFrames(), cycle, paused) }, IDENTITY_PROJECTION, VIEWPORT),
      );
    return { scene, context, at };
  }

  /** Plays from cycle 0 in `step`-cycle frames, landing exactly on `cycle`. */
  async function continuous(cycle: number, step = 5): Promise<SceneObservation> {
    const { at } = await legacyScene();
    for (let shown = 0; shown < cycle; shown += step) at(shown);
    return at(cycle);
  }

  async function seek(cycle: number): Promise<SceneObservation> {
    return (await legacyScene()).at(cycle, true);
  }

  const cued = ({ poses }: SceneObservation) =>
    Object.fromEntries(Object.entries(poses).filter(([, pose]) => !idleSeqIds.has(pose.seqId)));

  const effect = (spotAnimId: number, frame: number, at: [number, number, number]) => ({ spotAnimId, frame, at });
  const standing = ['healer', 'healer-2', 'mager', 'nib'];

  it.each([
    // Before the nibbler's delayed swing (cycle 50).
    { cycle: 45, poses: {}, effects: [], drawn: standing },
    // Its clip four cycles in: the second of its 2/3/5-cycle frames.
    { cycle: 54, poses: { nib: { seqId: 7574, frame: 1 } }, effects: [], drawn: standing },
    {
      // C-8: Zuk rises although his spawn tick is 10. The homing flight left at cycle 60.
      cycle: 64,
      poses: { mager: { seqId: 7610, frame: 1 }, zuk: { seqId: 7563, frame: 1 } },
      effects: [effect(659, 0, [25.5, 25.5, 0]), effect(1375, 0, [31.2333, 31.2333, 0.7792])],
      drawn: [...standing, 'zuk'],
    },
    {
      // The tracked graphic sits on the nibbler's rendered center, not its recorded [18, 18]. The
      // pruned healer's corpse plays its death clip; both flights keep their own phase.
      cycle: 100,
      poses: { healer: { seqId: 2638, frame: 2 } },
      effects: [
        effect(444, 0, [20.5, 20.5, 1.1719]),
        effect(659, 1, [25.5, 25.5, 0]),
        effect(660, 1, [26.0245, 29.1421, 1.6784]),
        effect(1375, 2, [24.3333, 24.3333, 0.5729]),
      ],
      drawn: [...standing, 'zuk'],
    },
    {
      // The tile flight's last cycle before its exclusive end at 130.
      cycle: 129,
      poses: { healer: { seqId: 2638, frame: 2 } },
      effects: [effect(444, 1, [20.5, 20.5, 1.1719]), effect(660, 2, [20.6841, 26.5881, 0.1012])],
      drawn: [...standing, 'zuk'],
    },
    {
      // The never-rendered tracked actor's graphic stands on its recorded fallback's center.
      cycle: 185,
      poses: { 'healer-2': { seqId: 2638, frame: 2 } },
      effects: [effect(448, 0, [23, 27, 2])],
      drawn: ['healer-2', 'mager', 'nib', 'zuk'],
    },
    // The type clear on tick 8 removed the pruned corpse before its clip ended.
    { cycle: 255, poses: {}, effects: [], drawn: ['mager', 'nib', 'zuk'] },
  ])('shows the same cues at cycle $cycle whether played or sought', async ({ cycle, poses, effects, drawn }) => {
    for (const observation of [await continuous(cycle), await seek(cycle)]) {
      expect(cued(observation)).toEqual(poses);
      expect(observation.effects).toEqual(effects);
      expect(observation.drawnNpcs).toEqual(drawn);
    }
  });

  it('starts and ends every flight, graphic and cued clip on the same cycles whether played or sought', async () => {
    const { at } = await legacyScene();
    const played = activeWindows((cycle) => at(cycle), 0, 270, idleSeqIds);
    const effects = { 1375: [60, 119], 659: [63, 122], 660: [70, 129], 444: [90, 149], 448: [180, 239] };
    // Zuk's rise plays from the intro's add at C-8 (tick 2), although his spawn tick is C.
    const clips = { 'nib:7574': [50, 59], 'mager:7610': [60, 69], 'zuk:7563': [60, 69] };
    expect(played.effects).toEqual(effects);
    expect(played.clips).toMatchObject(clips);
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

  it('keeps a pruned corpse to the end of its death clip on a seek, and drops it at a type clear', async () => {
    const shows = async (cycle: number, actorId: string) => (await seek(cycle)).poses[actorId]?.seqId === 2638;
    // `healer` dies on tick 3 (cycle 90) and is pruned on tick 4; its corpse lasts 90 cycles.
    expect(await Promise.all([89, 90, 179, 180].map((cycle) => shows(cycle, 'healer')))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    // `healer-2` dies on tick 6, is pruned on tick 7, and its type is cleared on tick 8.
    expect(await Promise.all([179, 180, 239, 240].map((cycle) => shows(cycle, 'healer-2')))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    const { at } = await legacyScene();
    expect(activeWindows((cycle) => at(cycle), 0, 270, idleSeqIds).clips['healer-2:2638']).toEqual([180, 239]);
  });

  // Known baseline failure on 49ef532: played one cycle per frame, the pruned corpse ends at 178,
  // one frame before a seek ends it (179), because the death timer is credited the frame's delta
  // from before the death. Larger frame steps end it earlier still. Not caused by cue playback.
  it.fails('ends a pruned corpse on the same cycle whether played or sought', async () => {
    const { at } = await legacyScene();
    expect(activeWindows((cycle) => at(cycle), 0, 270, idleSeqIds).clips['healer:2638']).toEqual([90, 179]);
  });

  it('hands in-flight and not-yet-started cues to live play at a takeover exactly as replay shows them', async () => {
    // Restored from tick 2's end (cycle 90): both flights are airborne, the tile spark is landing, the
    // tracked graphic starts this cycle and the fallback graphic is still 90 cycles away.
    const tick = 2;
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(1), combatSeed: 1 });
    const restoration: RestoredPresentation = {
      engine,
      tick,
      timeMs: (tick + 1) * 600,
      history: { frames: legacyFrames().slice(0, tick + 1), throughFrameIndex: tick },
    };
    const restored = await legacyScene();
    const replay = await legacyScene();
    const restoredAt = (cycle: number, paused: boolean) => {
      const frame = legacyFrames()[Math.floor(cycle / 30)];
      if (!frame) expect.fail(`No frame for cycle ${cycle}`);
      return observeScene(
        restored.scene,
        restored.scene.build(
          {
            ...restored.context,
            simulationState: frame.state,
            events: frame.events,
            interpolatedTick: cycle / 30,
            restoredPresentation: restoration,
            frameDeltaMs: paused ? 0 : 20,
            timeline: { timelineKey: 'restored-inferno', paused, timeMs: cycle * 20 },
          },
          IDENTITY_PROJECTION,
          VIEWPORT,
        ),
      );
    };
    const frame = legacyFrames()[tick];
    if (!frame) expect.fail('Missing the restored frame');
    for (let held = 0; held < 3; held++)
      observeScene(
        restored.scene,
        restored.scene.build(
          {
            ...restored.context,
            simulationState: frame.state,
            events: frame.events,
            interpolatedTick: tick + 1,
            restoredPresentation: restoration,
            frameDeltaMs: 0,
            timeline: { timelineKey: 'restored-inferno', paused: true, timeMs: restoration.timeMs },
          },
          IDENTITY_PROJECTION,
          VIEWPORT,
        ),
      );
    for (let cycle = 0; cycle <= 90; cycle++) replay.at(cycle);
    let sawPending = false;
    for (let cycle = 91; cycle <= 270; cycle++) {
      const live = restoredAt(cycle, false);
      expect(live.effects, `cycle ${cycle}`).toEqual(replay.at(cycle).effects);
      sawPending ||= live.effects.some(({ spotAnimId }) => spotAnimId === 448);
    }
    expect(sawPending).toBe(true);
  });
});

/**
 * The shared cue pipeline end to end on the shipped Inferno scene: the cue player and the effect
 * index's cue index, observed only through the render queue, NPC poses and frame sounds.
 */
describe('the shared encounter cue pipeline', () => {
  let recorded: readonly ReplayDisplayFrame[] | undefined;
  const legacyFrames = () => {
    recorded ??= legacyInfernoRecording().frames;
    return recorded;
  };
  const idleSeqIds = new Set(INFERNO_RENDER_CONFIG.preloadNpcTypes?.flatMap(({ idleSeqId }) => idleSeqId ?? []));
  const cued = ({ poses }: SceneObservation) =>
    Object.fromEntries(Object.entries(poses).filter(([, pose]) => !idleSeqIds.has(pose.seqId)));
  const scenes: SceneCompositor[] = [];
  afterEach(() => {
    for (const scene of scenes.splice(0)) scene.dispose();
  });

  /** The Inferno scene over `frames`; `priorities` sets a clip sequence's forced priority (default 5). */
  async function infernoScene(
    frames: readonly ReplayDisplayFrame[],
    priorities: Readonly<Record<number, number>> = {},
  ) {
    const scene = createZukSceneBuilder({ encounterRenderConfig: INFERNO_RENDER_CONFIG });
    if (!(scene instanceof SceneCompositor)) expect.fail('Expected a scene compositor');
    scenes.push(scene);
    const { loader, animation } = syntheticNpcAssets();
    vi.spyOn(animation, 'loadSeqType').mockImplementation((id) => {
      const sequence = new SeqType(id, cacheInfo);
      sequence.frameIds = [10, 11, 12];
      sequence.frameLengths = [...SYNTHETIC_CLIP_FRAME_CYCLES];
      sequence.forcedPriority = priorities[id] ?? 5;
      return sequence;
    });
    await scene.loadNpc(loader, animation);
    installSyntheticSpotAnims(scene, INFERNO_RENDER_CONFIG.spotAnimIds ?? []);
    return (cycle: number, paused = false) =>
      observeScene(
        scene,
        scene.build(
          {
            speedMultiplier: 1,
            interaction: { hoveredTile: null, targetTile: null },
            options: SCENE_OPTIONS,
            ...replayContextAt(frames, cycle, paused),
          },
          IDENTITY_PROJECTION,
          VIEWPORT,
        ),
      );
  }

  type SameCycleClips = {
    readonly order: readonly ('attack' | 'defend')[];
    readonly priorities: Readonly<Record<number, number>>;
    readonly shown: 'attack' | 'defend';
  };
  const higherAttack = { [INFERNO_WAVE_SEQS.nibbler.attack]: 8 };
  it.each<SameCycleClips>([
    { order: ['attack', 'defend'], priorities: higherAttack, shown: 'attack' },
    { order: ['defend', 'attack'], priorities: higherAttack, shown: 'attack' },
    { order: ['attack', 'defend'], priorities: {}, shown: 'defend' },
    { order: ['defend', 'attack'], priorities: {}, shown: 'attack' },
  ])('shows the same winner of clips $order starting on one cycle whether played or sought, with priorities $priorities', async ({
    order,
    priorities,
    shown,
  }) => {
    // The nibbler's clips both start at cycle 50: the higher priority wins, and on a tie the later one.
    const frames = legacyFrames().map((frame, tick) =>
      tick === 1
        ? {
            ...frame,
            events: [
              {
                type: 'encounter_visual',
                eventId: 11,
                tick: 1,
                animations: order.map((clipId) => ({ actorId: 'nib', clipId, delayCycles: 20 })),
                projectiles: [],
                graphics: [],
              } satisfies EncounterVisualEvent,
            ],
          }
        : frame,
    );
    const played = await infernoScene(frames, priorities);
    for (let cycle = 0; cycle < 53; cycle++) played(cycle);
    const sought = await infernoScene(frames, priorities);

    const playedPoses = cued(played(53));
    expect(playedPoses.nib?.seqId).toBe(INFERNO_WAVE_SEQS.nibbler[shown]);
    expect(cued(sought(53, true))).toEqual(playedPoses);
  });

  it('holds a restore silently while an encounter NPC type loads, then plays the cue on from its original clock', async () => {
    const { scene, draw, state, engine, play, update } = await frameAudio();
    const reference = await frameAudio();
    try {
      const manager = scene['npcInstanceManager'];
      // The attack's frames start at cycles 25, 27 and 30, each with its own sound (9000 + frame).
      const event: EncounterVisualEvent = {
        type: 'encounter_visual',
        eventId: 1,
        tick: 0,
        graphics: [],
        projectiles: [],
        animations: [{ actorId: ZUK_ACTOR_ID, clipId: 'attack', delayCycles: 25 }],
      };
      const frames: ReplayDisplayFrame[] = [{ state, events: [event] }];
      const restoration: RestoredPresentation = {
        engine,
        tick: 0,
        timeMs: 26 * 20,
        history: { frames, throughFrameIndex: 0 },
      };
      const pose = (target: InfernoSceneCompositor) =>
        target['npcInstanceManager']
          .getInstanceFrameStates()
          .find((entry) => entry.actorId === PRIMARY_NPC_ACTOR_ID)
          ?.animController?.getFrameState();
      const restored = (cycle: number, live = false) =>
        draw(cycle, {
          simulationState: { ...state, currentTick: Math.floor(cycle / 30) },
          events: live ? [] : [event],
          restoredPresentation: restoration,
          frameDeltaMs: 20,
          timeline: { timelineKey: 'restored-inferno', paused: false, timeMs: cycle * 20 },
        });
      const npcType = manager['typeRegistry'].get(7705);
      if (!npcType) expect.fail('Missing loaded NPC type');
      manager['typeRegistry'].delete(7705);

      // Held across the attack's second frame and its sound, without claiming the frame was drawn.
      const held = [26, 27, 28].map((cycle) => restored(cycle).replayPresentationReady);
      expect(held).toEqual([false, false, false]);
      expect(update).not.toHaveBeenCalled();
      manager['typeRegistry'].set(7705, npcType);
      expect(restored(29).replayPresentationReady).toBe(true);
      const restoredPose = pose(scene);
      expect(update).not.toHaveBeenCalled();
      restored(30, true);
      restored(31, true);

      for (let cycle = 0; cycle <= 29; cycle++)
        reference.draw(cycle, { events: [], replayHistory: { frames, throughFrameIndex: 0 } });
      expect(restoredPose).toMatchObject({ seqId: ZUK_SEQS.zuk.attack, currentFrameIndex: 1 });
      expect(restoredPose).toEqual(pose(reference.scene));
      // Only the frame first shown live sounds.
      expect(play.mock.calls.map(([id]) => id)).toEqual([9002]);
    } finally {
      scene.dispose();
      reference.scene.dispose();
    }
  });

  /** A real Zuk fight, recorded through the recorder as the app records one. */
  function recordZukFight(ticks: number) {
    const input: [number, number] = [40, 46];
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(1), combatSeed: 1, startPos: input });
    engine.setMechanicsConfig({ zukSets: false, infiniteHealth: true });
    const config = engine.getRunConfig();
    const recorder = new ReplayRecorder();
    recorder.startRun(config);
    recorder.recordFrame(0, input, engine.getState(), []);
    for (let tick = 1; tick <= ticks; tick++) {
      engine.advanceTick(input);
      recorder.recordFrame(tick, input, engine.getState(), engine.getLastTickEvents());
    }
    return { config, data: recorder.exportData() };
  }

  /** `data` as the build before the encounter visual batch would have written it. */
  function inOldShapes(data: ReplayRecorderData): ReplayRecorderData {
    const old: Record<string, string> = {
      encounter_visual: 'inferno_visual',
      actor_presentations_removed: 'inferno_clear_minions',
    };
    return {
      ...data,
      frames: data.frames.map((frame) => ({
        ...frame,
        events: frame.events.map((event) => (old[event.type] ? { ...event, type: old[event.type] } : event)),
      })),
    };
  }

  it('plays a branch taken over from a loaded old-shape recording exactly as the same fight recorded today', async () => {
    const { config, data } = recordZukFight(45);
    const today = new ReplayRecorder();
    today.load(data);
    const loaded = new ReplayRecorder();
    loaded.load(inOldShapes(data));
    expect(loaded.getDisplayFrames().map(({ events }) => events)).toEqual(
      today.getDisplayFrames().map(({ events }) => events),
    );
    // Take over just after the first Zuk ball launches, so it is airborne across the handoff.
    const takeover = loaded
      .getDisplayFrames()
      .findIndex(({ events }) =>
        events.some(
          (event) => isEncounterVisualEvent(event) && event.projectiles.some((cue) => cue.spotAnimId === 1375),
        ),
      );
    expect(takeover).toBeGreaterThan(0);
    const resumed = reconstructReplayPrefix(config, loaded.getReconstructionFrames(), takeover, null);
    if (!resumed) expect.fail('Expected the takeover engine');
    const suffix: ReplayDisplayFrame[] = data.frames.slice(takeover + 1).map((frame) => {
      resumed.advanceTick(frame.input);
      return { state: resumed.getState(), events: resumed.getLastTickEvents() };
    });
    const branch = [...loaded.getDisplayFrames().slice(0, takeover + 1), ...suffix];
    const batches = (frames: readonly ReplayDisplayFrame[]) =>
      frames.map(({ events }) => events.filter(isEncounterVisualEvent).map(({ eventId: _id, ...batch }) => batch));
    const prefixIds = branch.slice(0, takeover + 1).flatMap(({ events }) => events.map(({ eventId }) => eventId));
    const suffixIds = suffix.flatMap(({ events }) => events.map(({ eventId }) => eventId));

    // The branch's own batches, in today's shape, continue the prefix's ids and the same fight.
    expect(Math.min(...suffixIds)).toBe(Math.max(...prefixIds) + 1);
    expect(batches(suffix).flat().length).toBeGreaterThan(0);
    expect(batches(suffix)).toEqual(batches(today.getDisplayFrames().slice(takeover + 1)));
    const playBranch = await infernoScene(branch);
    const playToday = await infernoScene(today.getDisplayFrames());
    const lastCycle = (branch.length - 1) * 30;
    let effectsAfterTakeover = 0;
    const todayEffects: SceneObservation['effects'][] = [];
    for (let cycle = 0; cycle <= lastCycle; cycle++) {
      const shown = playBranch(cycle);
      const expected = playToday(cycle);
      todayEffects.push(expected.effects);
      expect(shown.effects, `cycle ${cycle}`).toEqual(expected.effects);
      expect(cued(shown), `cycle ${cycle}`).toEqual(cued(expected));
      if (cycle > (takeover + 1) * 30) effectsAfterTakeover += shown.effects.length;
    }
    expect(effectsAfterTakeover).toBeGreaterThan(0);
    for (const cycle of [(takeover + 1) * 30 + 7, lastCycle - 11])
      expect((await infernoScene(branch))(cycle, true).effects).toEqual(todayEffects[cycle]);
  });
});
