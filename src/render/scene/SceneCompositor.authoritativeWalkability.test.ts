import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocWithType } from '../../cache/CacheManager';
import { setArenaConfig } from '../../core/constants';
import type { CoreGameEvent } from '../../core/events/types';
import type { ReplayDisplayFrame } from '../../core/ReplayRecorder';
import { SimulationEngine } from '../../core/SimulationEngine';
import { LobbyEncounter } from '../../encounters/lobby/LobbyEncounter';
import { Archive } from '../../rs/cache/Archive';
import { LegacyCacheIndex } from '../../rs/cache/CacheIndex';
import { analyzeWalkability } from '../../rs/collision/WalkabilityAnalyzer';
import { LocModelLoader } from '../../rs/config/loctype/LocModelLoader';
import { LocModelType } from '../../rs/config/loctype/LocModelType';
import { LocType } from '../../rs/config/loctype/LocType';
import { SpotAnimType } from '../../rs/config/spotanimtype/SpotAnimType';
import type { MapSquareData } from '../../rs/map/MapLoader';
import { ModelData } from '../../rs/model/ModelData';
import { SpotAnimModelLoader } from '../../rs/model/SpotAnimModelLoader';
import { ResidentMeshEmbedder } from '../../test/helpers/residentMeshDraws';
import type { LineMarker } from '../../types/lineMarkers';
import type { TileGridStyle } from '../../types/tileGrid';
import { classifyMesh3DCommands } from '../backends/picogl/commandClassifier';
import type { Projection2D } from '../core/camera';
import { createQueue, type RenderQueue } from '../core/commands';
import { describePlayerEffects } from '../effects/playerEffectDescriptors';
import { getTerrainHeightInterpolated } from '../shared/renderUtils';
import { SceneCompositor, Z_LAYERS } from './SceneCompositor';
import type { RenderContext } from './types';

const MAP_SIZE = 64;
const projection: Projection2D = {
  tileToScreen: (tile) => tile,
  tileDeltaToScreen: (delta) => delta,
  screenToTile: () => null,
  tilePolygonScreen: (tile) => [
    { x: tile.x - 0.5, y: tile.y - 0.5 },
    { x: tile.x + 0.5, y: tile.y - 0.5 },
    { x: tile.x + 0.5, y: tile.y + 0.5 },
    { x: tile.x - 0.5, y: tile.y + 0.5 },
  ],
};

class TestCompositor extends SceneCompositor {
  walkabilityChecker(): ((x: number, y: number) => boolean) | null {
    return this.getArenaWalkabilityChecker();
  }

  gridBounds(): ReturnType<typeof this.getGridBounds> {
    return this.getGridBounds();
  }

  runBoundary(queue: RenderQueue): void {
    this.buildArenaBoundary(queue, projection);
  }

  setFallbackGridBounds(): void {
    this.terrainBounds = { minX: 0, maxX: 63, minY: 0, maxY: 63, width: 64, height: 64 };
  }
}

function makeOpenMapSquare(levels = 1): MapSquareData {
  const level = <T>(make: () => T): T[][] =>
    Array.from({ length: levels }, () => Array.from({ length: MAP_SIZE }, () => make()));
  return {
    mapX: 0,
    mapY: 0,
    tileHeights: level(() => new Int32Array(MAP_SIZE)),
    tileUnderlays: level(() => new Uint16Array(MAP_SIZE).fill(1)),
    tileOverlays: level(() => new Int16Array(MAP_SIZE)),
    tileShapes: level(() => new Uint8Array(MAP_SIZE)),
    tileRotations: level(() => new Uint8Array(MAP_SIZE)),
    tileRenderFlags: level(() => new Uint8Array(MAP_SIZE)),
    tileLightOcclusions: level(() => new Uint8Array(MAP_SIZE)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

function shotScene() {
  const scene = new TestCompositor();
  const state = new SimulationEngine({ encounter: new LobbyEncounter(), combatSeed: 1 }).getState();
  const effects = scene['spotAnimRenderer'];
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
  const loadType = vi.fn((id: number) => {
    const type = new SpotAnimType(id, {
      name: 'test',
      game: 'oldschool',
      environment: 'live',
      revision: 232,
      timestamp: '',
      size: 0,
    });
    type.modelId = id;
    return type;
  });
  const loader = new SpotAnimModelLoader(
    { load: loadType, getCount: () => 3000, clearCache: () => {} },
    { getModel: () => model },
  );
  scene['spotAnimModelLoader'] = loader;
  scene['playerEquipment'] = { weapon: 20997 };
  const draw = (tick: number, events: CoreGameEvent[] = [], overrides: Partial<RenderContext> = {}) =>
    scene.build(
      {
        simulationState: {
          ...state,
          playerCombatSupplies: { ...state.playerCombatSupplies, equippedAmmo: { id: 882 } },
          currentTick: Math.floor(tick),
          playerPosition: [0, 0],
          primaryNpcPosition: [10, 0],
          primaryNpcSize: 1,
          npcs: [],
        },
        events,
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
        interpolatedTick: tick,
        speedMultiplier: 1,
        ...overrides,
      } satisfies RenderContext,
      projection,
      { width: 800, height: 600, dpr: 1 },
    );
  return { scene, effects, draw, loadType, loader, state };
}

const arrowShot = {
  type: 'attack_started',
  sourceId: 'player',
  targetId: 'target',
  eventId: 1,
  tick: 0,
  style: 'range',
  attackKind: 'range_arrow',
  weaponId: 20997,
  ammoId: 11212,
  ammoSource: 'quiver',
} as const satisfies CoreGameEvent;

function lineScene(renderMode: '2d' | '3d') {
  const { scene, draw } = shotScene();
  setArenaConfig({ bounds: null, walkableTiles: new Set(), collisionMap: null }, true);
  scene['terrainHeights'] = Array.from({ length: 65 }, (_, x) =>
    Int32Array.from({ length: 65 }, (_, y) => -(x + y) * 128),
  );
  return {
    scene,
    draw: (lineMarkers: LineMarker[], lineMarkerWidth?: number) =>
      draw(0, [], {
        lineMarkers,
        options: {
          renderMode,
          showCoordinates: false,
          showNpcClickbox: false,
          showTileMarkers: false,
          showTileMarkerLabels: false,
          showLineMarkers: true,
          showLineMarkerLabels: true,
          lineMarkerWidth,
          smoothTerrain: false,
          brightness: 1,
          contrast: 1,
          saturation: 1,
          encounterDebugFlags: {},
        },
      }),
  };
}

function markerVertices(queue: RenderQueue): number[][] {
  return queue.commands.flatMap((command) => {
    if (
      command.kind !== 'mesh3d' ||
      command.zIndex !== Z_LAYERS.TILE_MARKERS ||
      !('positions' in command) ||
      !(command.positions instanceof Float32Array)
    )
      return [];
    const positions = command.positions;
    return Array.from({ length: positions.length / 3 }, (_, index) =>
      Array.from(positions.slice(index * 3, index * 3 + 3)),
    );
  });
}

describe('SceneCompositor line marker joins', () => {
  const horizontal: LineMarker = { x: 10, y: 10, orientation: 'horizontal', color: '#ff0000', opacity: 0.6 };
  const vertical: LineMarker = { ...horizontal, orientation: 'vertical' };

  it('covers the outer corner when same-style 3D line markers form an L', () => {
    const { scene, draw } = lineScene('3d');

    const queue = draw([horizontal, vertical]);

    expect(markerVertices(queue)).toContainEqual([9.99, 9.99, 20.01].map(Math.fround));
    scene.dispose();
  });

  it('puts the corner inside a joined path when same-style 2D line markers form an L', () => {
    const { scene, draw } = lineScene('2d');

    const queue = draw([horizontal, vertical]);

    expect(queue.commands.filter((command) => command.zIndex === Z_LAYERS.TILE_MARKERS)).toContainEqual(
      expect.objectContaining({
        kind: 'poly2d',
        points: [
          { x: 10.5, y: 10 },
          { x: 10, y: 10 },
          { x: 10, y: 10.5 },
        ],
        stroke: { color: { r: 1, g: 0, b: 0, a: 0.6 }, widthPx: 1 },
        closePath: false,
      }),
    );
    scene.dispose();
  });

  describe.each(['2d', '3d'] as const)('in %s', (renderMode) => {
    it.each([
      undefined,
      2.5,
    ])('retains butt endpoints and the label when a segment is isolated at width %s', (width) => {
      const { scene, draw } = lineScene(renderMode);

      const queue = draw([{ ...horizontal, label: 'West' }], width);

      const commands = queue.commands.filter((command) => command.zIndex === Z_LAYERS.TILE_MARKERS);
      if (renderMode === '2d') {
        const points = commands.flatMap((command) => (command.kind === 'poly2d' ? command.points : []));
        expect(points).toEqual([
          { x: 10.5, y: 10 },
          { x: 10, y: 10 },
          { x: 10.5, y: 10 },
          { x: 11, y: 10 },
        ]);
        for (const command of commands) expect(command).toHaveProperty('stroke.widthPx', width ?? 1);
        expect(queue.commands).toContainEqual(expect.objectContaining({ kind: 'text2d', text: 'West' }));
      } else {
        const vertices = markerVertices(queue);
        expect(vertices).toHaveLength(6);
        expect(vertices.map(([x]) => x)).toEqual([10, 11, 11, 10, 11, 10]);
        expect(vertices[0]).toEqual([10, 10 - (width ?? 1) * 0.01, 20.01].map(Math.fround));
        expect(queue.tileMarkerLabels).toEqual([
          { screenX: 10.5, screenY: 10, text: 'West', color: '#ff0000', key: 'line:horizontal:10,10' },
        ]);
      }
      scene.dispose();
    });

    it.each([
      { name: 'collinear', lines: [horizontal, { ...horizontal, x: 9 }] },
      { name: 'T', lines: [horizontal, { ...horizontal, x: 9 }, vertical] },
      { name: 'cross', lines: [horizontal, { ...horizontal, x: 9 }, vertical, { ...vertical, y: 9 }] },
    ])('retains every segment without protruding corners when lines form a $name', ({ lines }) => {
      const { scene, draw } = lineScene(renderMode);

      const queue = draw(lines);

      if (renderMode === '2d') {
        let totalLength = 0;
        for (const command of queue.commands) {
          if (command.kind !== 'poly2d' || command.zIndex !== Z_LAYERS.TILE_MARKERS) continue;
          const first = command.points[0];
          expect(command.points.every(({ x }) => x === first.x) || command.points.every(({ y }) => y === first.y)).toBe(
            true,
          );
          for (let index = 1; index < command.points.length; index++) {
            const start = command.points[index - 1];
            const end = command.points[index];
            totalLength += Math.hypot(end.x - start.x, end.y - start.y);
          }
        }
        expect(totalLength).toBe(lines.length);
      } else {
        const vertices = markerVertices(queue);
        expect(vertices).toHaveLength(lines.length * 6);
        expect(vertices.every(([x, y]) => Number.isInteger(x) || Number.isInteger(y))).toBe(true);
      }
      scene.dispose();
    });

    it('preserves each segment style without recoloring joins when colors or opacity differ', () => {
      const { scene, draw } = lineScene(renderMode);
      const lines = [
        horizontal,
        { ...vertical, color: '#0000ff', opacity: 0.3 },
        { ...horizontal, x: 9, opacity: 0.8 },
      ];

      const queue = draw(lines, 2.5);

      const commands = queue.commands.filter((command) => command.zIndex === Z_LAYERS.TILE_MARKERS);
      if (renderMode === '2d') {
        expect(commands).toHaveLength(6);
        for (const [index, color] of [
          { r: 1, g: 0, b: 0, a: 0.6 },
          { r: 0, g: 0, b: 1, a: 0.3 },
          { r: 1, g: 0, b: 0, a: 0.8 },
        ].entries()) {
          for (const command of commands.slice(index * 2, index * 2 + 2)) {
            expect(command).toMatchObject({ kind: 'poly2d', stroke: { color, widthPx: 2.5 } });
          }
        }
      } else {
        expect(commands).toEqual([
          scene['createEdgeMesh3D'](
            10,
            10,
            11,
            10,
            scene['hexToPackedHsl']('#ff0000'),
            0.05,
            Z_LAYERS.TILE_MARKERS,
            0.6,
          ),
          scene['createEdgeMesh3D'](
            10,
            10,
            10,
            11,
            scene['hexToPackedHsl']('#0000ff'),
            0.05,
            Z_LAYERS.TILE_MARKERS,
            0.3,
          ),
          scene['createEdgeMesh3D'](
            9,
            10,
            10,
            10,
            scene['hexToPackedHsl']('#ff0000'),
            0.05,
            Z_LAYERS.TILE_MARKERS,
            0.8,
          ),
        ]);
      }
      scene.dispose();
    });
  });
});

describe('SceneCompositor tile grid', () => {
  const style: TileGridStyle = { color: '#ffffff', opacity: 0.3, width: 1 };

  function gridScene() {
    const { scene, draw } = shotScene();
    setArenaConfig({ bounds: null, walkableTiles: new Set(), collisionMap: null }, true);
    scene['terrainHeights'] = Array.from({ length: 65 }, (_, x) =>
      Int32Array.from({ length: 65 }, (_, y) => -(x + y) * 128),
    );
    scene['terrainBounds'] = { minX: 10, maxX: 20, minY: 30, maxY: 35, width: 11, height: 6 };
    return {
      scene,
      draw: (tileGrid: TileGridStyle | null, renderMode: '2d' | '3d' = '3d') =>
        draw(0, [], {
          tileMarkers: [{ x: 12, y: 32, color: '#ff0000', opacity: 1 }],
          lineMarkers: [{ x: 14, y: 32, orientation: 'horizontal', color: '#00ff00', opacity: 1 }],
          options: {
            renderMode,
            showCoordinates: false,
            tileGrid,
            showNpcClickbox: false,
            showTileMarkers: true,
            showTileMarkerLabels: false,
            showLineMarkers: true,
            showLineMarkerLabels: false,
            smoothTerrain: false,
            brightness: 1,
            contrast: 1,
            saturation: 1,
            encounterDebugFlags: {},
          },
        }),
    };
  }

  const gridCommands = (queue: RenderQueue) =>
    queue.commands.filter((command) => command.kind === 'mesh3d' && command.meshId.startsWith('tile-grid-'));

  it('draws in the transparent pass, under every marker and outline in the later no-depth pass', () => {
    const { scene, draw } = gridScene();

    const queue = draw(style);

    const [grid] = gridCommands(queue);
    if (!grid || grid.kind !== 'mesh3d') expect.fail('Expected the tile grid');
    const buckets = classifyMesh3DCommands(queue.commands);
    expect(buckets.transparent).toContain(grid);
    expect(buckets.noDepth).not.toContain(grid);
    // Tile marker, line marker and true-tile outline all draw after it, whatever their queue order.
    const overlays = queue.commands.filter(
      (command) =>
        command.kind === 'mesh3d' && (command.zIndex === Z_LAYERS.TILE_MARKERS || command.zIndex === Z_LAYERS.HOVER),
    );
    expect(overlays.length).toBeGreaterThanOrEqual(3);
    for (const overlay of overlays) expect(buckets.noDepth).toContain(overlay);
    scene.dispose();
  });

  it('queues the screen-space grid lines and arena outline only for a 2D render', () => {
    const { scene, draw } = gridScene();
    setArenaConfig({ bounds: null, walkableTiles: new Set(['12,32', '13,32', '12,33']), collisionMap: null }, true);
    const screenOverlays = (queue: RenderQueue) =>
      queue.commands.filter(
        (command) =>
          command.kind === 'poly2d' && (command.zIndex === Z_LAYERS.GRID || command.zIndex === Z_LAYERS.GRID + 5),
      );

    // These are poly2d only, which the 3D backend never draws, so leaving them out of a 3D frame leaves everything it draws unchanged.
    const unbounded = createQueue();
    scene['buildGridLines'](unbounded, projection);
    scene['buildArenaBoundary'](unbounded, projection);
    expect(unbounded.commands.some((command) => command.zIndex === Z_LAYERS.GRID + 5)).toBe(true);
    expect(unbounded.commands.every((command) => command.kind === 'poly2d')).toBe(true);

    expect(screenOverlays(draw(style, '3d'))).toEqual([]);

    const reference = createQueue();
    scene['buildGridLines'](reference, projection, { width: 800, height: 600, dpr: 1 });
    scene['buildArenaBoundary'](reference, projection);
    // A 2D frame still queues them together, in their original order.
    const queue2D = draw(null, '2d').commands;
    const first = JSON.stringify(reference.commands[0]);
    const start = queue2D.findIndex((command) => JSON.stringify(command) === first);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(queue2D.slice(start, start + reference.commands.length)).toEqual(reference.commands);
    scene.dispose();
  });

  it('covers the scene terrain bounds rather than the whole map', () => {
    const { scene, draw } = gridScene();

    const [grid] = gridCommands(draw(style));

    if (!grid || !('positions' in grid) || !(grid.positions instanceof Float32Array)) expect.fail('Expected grid');
    const xs = grid.positions.filter((_, i) => i % 3 === 0);
    const ys = grid.positions.filter((_, i) => i % 3 === 1);
    expect(Math.min(...xs)).toBeCloseTo(10 - 0.01);
    expect(Math.max(...xs)).toBeCloseTo(21 + 0.01);
    expect(Math.min(...ys)).toBeCloseTo(30 - 0.01);
    expect(Math.max(...ys)).toBeCloseTo(36 + 0.01);
    scene.dispose();
  });

  it('reuses the built mesh until the style or the terrain changes', () => {
    const { scene, draw } = gridScene();

    const [first] = gridCommands(draw(style));
    const [again] = gridCommands(draw({ ...style }));
    const [fainter] = gridCommands(draw({ ...style, opacity: 0.5 }));
    const [wider] = gridCommands(draw({ ...style, opacity: 0.5, width: 2 }));
    const [recoloured] = gridCommands(draw({ ...style, opacity: 0.5, width: 2, color: '#000000' }));
    scene['terrainHeights'] = Array.from({ length: 65 }, () => new Int32Array(65));
    const [newTerrain] = gridCommands(draw({ ...style, opacity: 0.5, width: 2, color: '#000000' }));

    expect(again).toBe(first);
    const rebuilt = [first, fainter, wider, recoloured, newTerrain];
    expect(new Set(rebuilt).size).toBe(5);
    expect(new Set(rebuilt.slice(0, 4).map((command) => command?.kind === 'mesh3d' && command.meshId)).size).toBe(4);
    scene.dispose();
  });

  it('draws nothing while off, or in 2D', () => {
    const { scene, draw } = gridScene();

    expect(gridCommands(draw(null))).toEqual([]);
    expect(gridCommands(draw(style, '2d'))).toEqual([]);
    scene.dispose();
  });
});

describe('SceneCompositor player shot rendering', () => {
  it.each(
    [
      { spellId: 'Ice Burst', cycle: 75, meshId: 366, impact: false },
      { spellId: 'Ice Barrage', cycle: 107, meshId: 369, impact: true },
      { spellId: 'Blood Burst', cycle: 106, meshId: 376, impact: true },
      { spellId: 'Blood Barrage', cycle: 106, meshId: 377, impact: true },
    ].flatMap((spell) => [true, false].map((accurate) => ({ ...spell, accurate }))),
  )('matches live per-target meshes when reconstructing $spellId with secondary accurate=$accurate', ({
    spellId,
    cycle,
    meshId,
    impact,
    accurate,
  }) => {
    const live = shotScene();
    const sought = shotScene();
    const primary: CoreGameEvent = {
      ...arrowShot,
      tick: 50,
      spellId,
      style: 'magic',
      attackKind: 'magic_water',
      spellCast: { sourcePosition: [1, 2], targetPosition: [7, 2], targetSize: 1, accurate: true },
    };
    const secondary: CoreGameEvent = {
      type: 'spell_targeted',
      eventId: 2,
      tick: 50,
      sourceId: 'player',
      targetId: 'secondary',
      spellId,
      impactDelayTicks: 0,
      spellCast: { sourcePosition: [1, 2], targetPosition: [7, 3], targetSize: 2, accurate },
    };
    const frames: ReplayDisplayFrame[] = Array.from({ length: 5 }, (_, index) => ({
      state: {
        ...live.state,
        currentTick: 50 + index,
        playerPosition: [40, 40],
        primaryNpcPosition: [50, 50],
        npcs: [],
      },
      events: index === 0 ? [primary, secondary] : [],
    }));
    live.draw(50, [primary, secondary]);
    for (let elapsed = 17; elapsed < cycle; elapsed += 17) live.draw(50 + elapsed / 30);

    const continuous = live.draw(50 + cycle / 30);
    const destination = frames[Math.floor(cycle / 30)];
    if (!destination) expect.fail('Expected destination frame');
    const reconstructed = sought.draw(50 + cycle / 30, [], {
      simulationState: destination.state,
      replayHistory: { frames, throughFrameIndex: Math.floor(cycle / 30) },
      timeline: { timelineKey: 'replay', paused: false, timeMs: 30000 + cycle * 20 },
    });
    // Opaque spotanim parts draw from GPU-resident sources; each scene's loader bakes its own, so
    // compare the arrays they upload rather than the source objects.
    const embedder = new ResidentMeshEmbedder();
    const meshes = (queue: RenderQueue) =>
      queue.commands
        .filter((command) => command.kind === 'mesh3d' && command.meshId === `spotanim-${meshId}-opaque`)
        .map((command) => embedder.embed(command));

    expect(meshes(reconstructed)).toEqual(meshes(continuous));
    expect(
      meshes(reconstructed).flatMap((command) =>
        command.kind === 'mesh3d' ? [Array.from(command.modelMatrix).slice(12, 14)] : [],
      ),
    ).toEqual(
      accurate || !impact
        ? [
            [7.5, 2.5],
            [8, 4],
          ]
        : [[7.5, 2.5]],
    );
    live.scene.dispose();
    sought.scene.dispose();
  });

  it('keeps the primary caster graphic when a target-only spell event follows it', () => {
    const { state, scene } = shotScene();
    const primary: CoreGameEvent = {
      ...arrowShot,
      spellId: 'Ice Blitz',
      style: 'magic',
      attackKind: 'magic_water',
      spellCast: { sourcePosition: [1, 2], targetPosition: [7, 2], targetSize: 1, accurate: true },
    };
    const secondary: CoreGameEvent = {
      type: 'spell_targeted',
      eventId: 2,
      tick: 0,
      sourceId: 'player',
      targetId: 'secondary',
      spellId: 'Ice Blitz',
      impactDelayTicks: 0,
      spellCast: { sourcePosition: [1, 2], targetPosition: [7, 3], targetSize: 2, accurate: true },
    };

    const effects = describePlayerEffects({ state, events: [primary, secondary] });

    expect(effects.filter((effect) => effect.kind === 'graphic')).toEqual([
      { kind: 'graphic', key: 'event-1', tick: 0, spotAnimId: 366, height: 124 },
    ]);
    expect(effects.filter((effect) => effect.kind === 'impact')).toHaveLength(2);
    scene.dispose();
  });

  it.each([
    { spellId: 'Ice Barrage', cycle: 75, meshId: 368 },
    { spellId: 'Ice Barrage', cycle: 107, meshId: 369 },
    { spellId: 'Blood Barrage', cycle: 106, meshId: 377 },
  ])('reconstructs $spellId at original cycle $cycle with static cache readiness and launch geometry', ({
    spellId,
    cycle,
    meshId,
  }) => {
    const continuous = shotScene();
    const sought = shotScene();
    const event: CoreGameEvent = {
      ...arrowShot,
      tick: 50,
      spellId,
      style: 'magic',
      attackKind: 'magic_water',
      spellCast: { sourcePosition: [1, 2], targetPosition: [7, 2], targetSize: 1, accurate: true },
    };
    const frames: ReplayDisplayFrame[] = Array.from({ length: 5 }, (_, index) => ({
      state: {
        ...continuous.state,
        currentTick: 50 + index,
        playerPosition: index === 0 ? [1, 2] : [40, 40],
        primaryNpcPosition: index === 0 ? [7, 2] : [50, 50],
        npcs: [],
      },
      events: index === 0 ? [event] : [],
    }));
    const contextAt = (elapsedCycle: number): Partial<RenderContext> => {
      const frameIndex = Math.floor(elapsedCycle / 30);
      const frame = frames[frameIndex];
      if (!frame) expect.fail('Expected replay frame');
      return {
        simulationState: frame.state,
        replayHistory: { frames, throughFrameIndex: frameIndex },
        timeline: { timelineKey: 'replay', paused: false, timeMs: 30000 + elapsedCycle * 20 },
      };
    };
    for (let elapsed = 0; elapsed < cycle; elapsed += 17) continuous.draw(50 + elapsed / 30, [], contextAt(elapsed));
    // Opaque spotanim parts draw from GPU-resident sources; each scene's loader bakes its own, so
    // compare the arrays they upload rather than the source objects.
    const embedder = new ResidentMeshEmbedder();
    const expected = continuous
      .draw(50 + cycle / 30, [], contextAt(cycle))
      .commands.filter((command) => command.kind === 'mesh3d' && command.meshId === `spotanim-${meshId}-opaque`)
      .map((command) => embedder.embed(command));
    sought.scene['playerEquipment'] = { weapon: 123 };

    const actual = sought
      .draw(50 + cycle / 30, [], contextAt(cycle))
      .commands.filter((command) => command.kind === 'mesh3d' && command.meshId === `spotanim-${meshId}-opaque`)
      .map((command) => embedder.embed(command));

    expect(actual).toHaveLength(1);
    expect(actual).toEqual(expected);
    const command = actual[0];
    if (!command || command.kind !== 'mesh3d') expect.fail('Expected replay effect mesh');
    expect(command.modelMatrix[12]).toBeCloseTo(7.5);
    expect(command.modelMatrix[13]).toBeCloseTo(2.5);
  });
  it.each([
    ['Smoke Burst', 388],
    ['Ice Burst', 366],
    ['Smoke Barrage', 390],
    ['Ice Barrage', 368],
  ] as const)('starts %s at the target while retaining caster-distance timing', (spellId, projectileId) => {
    const { scene, draw } = shotScene();
    const event: CoreGameEvent = {
      ...arrowShot,
      spellId,
      style: 'magic',
      attackKind: 'magic_water',
      spellCast: { sourcePosition: [1, 2], targetPosition: [7, 2], targetSize: 1, accurate: true },
    };

    draw(0, [event]);
    const before = [...draw(50 / 30).commands];
    const launch = draw(51 / 30);

    expect([...scene['projectileController']['activeProjectiles'].values()]).toMatchObject([
      { sourceX: 7, sourceY: 2, flight: { config: { startCycle: 51, endCycleExclusive: 106, startOffset: 64 } } },
    ]);
    expect(before).not.toContainEqual(expect.objectContaining({ meshId: `spotanim-${projectileId}-opaque` }));
    const projectile = launch.commands.find(
      (command) => command.kind === 'mesh3d' && command.meshId === `spotanim-${projectileId}-opaque`,
    );
    if (!projectile || projectile.kind !== 'mesh3d') expect.fail('Expected Ancient projectile');
    expect(Array.from(projectile.modelMatrix).slice(12, 15)).toEqual([7.5, 2.5, 172 / 128]);
  });

  it.each([
    [1, 56],
    [2, 66],
    [3, 76],
    [6, 106],
  ])('renders a direct Ancient impact at exact cycle %i tiles / %i cycles', (distance, cycles) => {
    const { draw } = shotScene();
    draw(4, [
      {
        ...arrowShot,
        tick: 4,
        spellId: 'Blood Barrage',
        style: 'magic',
        attackKind: 'magic_shadow',
        impactDelayTicks: 9,
        spellCast: { sourcePosition: [10, 10], targetPosition: [10 + distance, 10], targetSize: 1, accurate: true },
      },
    ]);
    for (let tick = 5; tick < 4 + cycles / 30; tick++) draw(tick);
    const before = [...draw(4 + (cycles - 0.01) / 30).commands];

    const impact = draw(4 + cycles / 30);

    expect(before).not.toContainEqual(expect.objectContaining({ meshId: 'spotanim-377-opaque' }));
    expect(impact.commands).toContainEqual(expect.objectContaining({ meshId: 'spotanim-377-opaque' }));
  });

  it.each([
    ['Smoke Rush', 385, 124],
    ['Shadow Rush', 379, 0],
  ] as const)('uses caster geometry and actor-origin impact placement for %s', (spellId, impactId, impactHeight) => {
    const { scene, effects, draw } = shotScene();
    draw(0, [
      {
        ...arrowShot,
        spellId,
        style: 'magic',
        attackKind: 'magic_shadow',
        spellCast: { sourcePosition: [1, 2], targetPosition: [3, 2], targetSize: 1, accurate: true },
      },
    ]);
    const cache = effects['meshCache'].get(impactId);
    if (!cache) expect.fail('Expected loaded Ancient impact');
    cache.heightOffset = 128;
    const launchQueue = draw(51 / 30);
    const projectile = launchQueue.commands.find(
      (command) => command.kind === 'mesh3d' && command.meshId.startsWith('spotanim-'),
    );
    if (!projectile || projectile.kind !== 'mesh3d') expect.fail('Expected Ancient projectile');
    const launchPosition = Array.from(projectile.modelMatrix).slice(12, 15);

    const impactQueue = draw(66 / 30);

    expect(launchPosition).toEqual([2, 2.5, 172 / 128]);
    const impact = impactQueue.commands.find(
      (command) => command.kind === 'mesh3d' && command.meshId === `spotanim-${impactId}-opaque`,
    );
    if (!impact || impact.kind !== 'mesh3d') expect.fail('Expected Ancient impact');
    expect(Array.from(impact.modelMatrix).slice(12, 15)).toEqual([3.5, 2.5, impactHeight / 128]);
    expect([...scene['projectileController']['activeImpacts'].values()]).toMatchObject([{ useNpcCenterHeight: false }]);
  });

  it('raises only the Ice Blitz caster graphic by the captured 124 units', () => {
    const { scene, draw } = shotScene();

    const queue = draw(0, [{ ...arrowShot, spellId: 'Ice Blitz', style: 'magic', attackKind: 'magic_water' }]);

    expect(scene['projectileController']['activeProjectiles'].size).toBe(0);
    const graphic = queue.commands.find(
      (command) => command.kind === 'mesh3d' && command.meshId === 'spotanim-366-opaque',
    );
    if (!graphic || graphic.kind !== 'mesh3d') expect.fail('Expected Ice Blitz caster graphic');
    expect(graphic.modelMatrix[14]).toBeCloseTo(124 / 128);
    expect([...scene['projectileController']['activeImpacts'].values()]).toMatchObject([{ spotAnimId: 367 }]);
  });

  it.each([
    'Blood Barrage',
    'Smoke Rush',
  ])('splashes instead of the success graphic when %s is a known miss', (spellId) => {
    const { scene, draw } = shotScene();

    draw(0, [
      {
        ...arrowShot,
        spellId,
        style: 'magic',
        attackKind: 'magic_shadow',
        impactDelayTicks: 3,
        spellCast: { sourcePosition: [1, 2], targetPosition: [7, 2], targetSize: 1, accurate: false },
      },
    ]);

    expect([...scene['projectileController']['activeImpacts'].values()]).toMatchObject([
      { spotAnimId: 85, heightOffset: 124 / 128, heightOffsetMode: 'actor', useNpcCenterHeight: false },
    ]);
  });

  it('rebinds scene elevation after a transient reset while preserving the stable callback', () => {
    const { scene, draw } = shotScene();
    scene['terrainHeights'] = Array.from({ length: 65 }, () => new Int32Array(65).fill(-256));
    const resolveSurfaceHeight = scene['resolveSurfaceHeight'];
    draw(0, [arrowShot]);
    scene.resetIntroState();

    draw(0, [{ ...arrowShot, eventId: 2 }]);
    const queue = draw(41 / 30);

    const projectile = queue.commands.find(
      (command) => command.kind === 'mesh3d' && command.meshId === 'spotanim-1120-opaque',
    );
    if (!projectile || projectile.kind !== 'mesh3d') expect.fail('Missing projectile');
    expect(projectile.modelMatrix[14]).toBeCloseTo((256 + 163) / 128);
    expect(resolveSurfaceHeight).toBeTypeOf('function');
    expect(scene['projectileController']['surfaceHeightResolver']).toBe(resolveSurfaceHeight);
  });

  it('raises the nocked dragon arrow without changing its flying projectile height', () => {
    const { scene, draw } = shotScene();

    draw(0, [arrowShot]);
    const queue = draw(0.5);

    const graphic = queue.commands.find(
      (command) => command.kind === 'mesh3d' && command.meshId === 'spotanim-1116-opaque',
    );
    if (!graphic || graphic.kind !== 'mesh3d') throw new TypeError('Missing nocked dragon arrow');
    expect(graphic.modelMatrix[14]).toBeCloseTo(96 / 128);
    expect([...scene['projectileController']['activeProjectiles'].values()]).toMatchObject([
      { spotAnimId: 1120, startHeight: 163 },
    ]);
  });

  it('loads and renders the launched quiver arrow instead of the equipped bronze arrow', () => {
    const { scene, effects, draw, loadType } = shotScene();

    draw(0, [arrowShot]);
    scene['playerEquipment'] = { weapon: 27275 };
    draw(1);
    const queue = draw(2);

    expect(loadType).toHaveBeenCalledWith(1120);
    expect(effects.isLoaded(1116)).toBe(true);
    expect(effects.isLoaded(10)).toBe(false);
    expect(queue.commands).toContainEqual(expect.objectContaining({ meshId: 'spotanim-1120-opaque' }));
  });

  it.each([20997, 27275])('uses magic flight when Ice Burst is cast holding %i', (weaponId) => {
    const { scene, draw } = shotScene();

    draw(0, [{ ...arrowShot, weaponId, spellId: 'Ice Burst', style: 'magic', attackKind: 'magic_water' }]);

    expect([...scene['projectileController']['activeProjectiles'].values()]).toMatchObject([
      { spotAnimId: 366, flight: { config: { startCycle: 51, endCycleExclusive: 146, startOffset: 64 } } },
    ]);
  });

  it.each([20997, 27275])('does not substitute weapon effects for an unknown spell held with %i', (weaponId) => {
    const { scene, effects, draw } = shotScene();

    draw(0, [{ ...arrowShot, weaponId, spellId: 'unmapped-test-spell', style: 'magic', attackKind: 'magic_fire' }]);

    expect(scene['projectileController']['activeProjectiles'].size).toBe(0);
    expect(scene['playerGraphicController']['activeGraphic']).toBeNull();
    expect(effects['meshCache'].size).toBe(0);
    expect(scene['pendingPlayerAttack']?.kind).not.toBe('weapon');
  });

  it('does not launch equipped ammunition for a melee attack event', () => {
    const { scene, effects, draw } = shotScene();

    draw(0, [{ ...arrowShot, weaponId: 4587, style: 'melee', attackKind: 'melee_slash' }]);

    expect(scene['projectileController']['activeProjectiles'].size).toBe(0);
    expect(effects['meshCache'].size).toBe(0);
  });

  it('schedules the direct Dark Demonbane impact from the event hit delay', () => {
    const { scene, draw } = shotScene();

    draw(4, [
      {
        ...arrowShot,
        eventId: 2,
        tick: 4,
        weaponId: 21006,
        spellId: 'Dark Demonbane',
        style: 'magic',
        attackKind: 'magic_shadow',
        impactDelayTicks: 5,
      },
    ]);

    expect(scene['projectileController']['activeProjectiles'].size).toBe(0);
    expect([...scene['projectileController']['activeImpacts'].values()]).toMatchObject([
      { spotAnimId: 1870, startTick: 9 },
    ]);
  });
});

describe('SceneCompositor surface loading', () => {
  function terrainFixture() {
    const scene = new TestCompositor();
    scene.setEncounterRenderConfig({
      terrainMapSquare: { x: 0, y: 0 },
      mapSquareOffsets: [
        { dx: -1, dy: 0 },
        { dx: 0, dy: 0 },
      ],
      locRender: {
        levels: [0, 1],
        excludedLocIds: [2],
        excludedRegions: [{ minX: -8, maxX: -8, minY: 10, maxY: 10 }],
        replacements: [{ localX: -9, localY: 10, sourceLocId: 3, targetLocId: 30, targetRotation: 0 }],
      },
    });
    const mapLoader = {
      loadMapSquare: async (mapX: number, mapY: number) => {
        const map = makeOpenMapSquare(4);
        map.mapX = mapX;
        map.mapY = mapY;
        map.tileHeights.forEach((plane, level) => {
          plane.forEach((row) => {
            row.fill(-128 * (2 + level + mapX));
          });
        });
        map.tileRenderFlags[1][8][8] = 2;
        return map;
      },
    };
    return { scene, mapLoader };
  }

  it('retains all raw planes and padded rendered squares but excludes context-only neighbors', async () => {
    const { scene, mapLoader } = terrainFixture();
    scene.setEncounterRenderConfig({
      terrainMapSquare: { x: 0, y: 0 },
      mapSquareOffsets: [
        { dx: -1, dy: 0 },
        { dx: 0, dy: 0 },
      ],
      locRender: { levels: [0] },
    });

    const meshes = await scene.buildTerrainMeshes3D(mapLoader);

    expect(meshes).toHaveLength(2);
    expect(scene['resolveSurfaceHeight'](-10.5, 10.5)).toBe(-128);
    expect(scene['resolveSurfaceHeight'](8.5, 8.5)).toBe(-384);
    expect(scene['surfaceHeightResolver'].resolve(10.5, 10.5, 3)).toBe(-640);
    expect(scene['resolveSurfaceHeight'](-0.5, 10.5)).toBe(-192);
    expect(scene['resolveSurfaceHeight'](64.5, 10.5)).toBe(0);
  });

  it('composes every arena square into the actor height grid, not the scenery squares', async () => {
    const { scene, mapLoader } = terrainFixture();
    scene.setEncounterRenderConfig({
      terrainMapSquare: { x: 0, y: 0 },
      mapSquareOffsets: [
        { dx: -1, dy: 0 },
        { dx: 0, dy: 0 },
        { dx: 1, dy: 0 },
      ],
      // The origin and the square east of it; the west square is scenery only.
      arenaMapSquareOffsets: [
        { dx: 0, dy: 0 },
        { dx: 1, dy: 0 },
      ],
      locRender: { levels: [0] },
    });

    await scene.buildTerrainMeshes3D(mapLoader);

    const heights = scene.getTerrainHeights();
    expect(heights).toHaveLength(128);
    // Both sides of the seam at x = 64: the origin square (map x 0) and the east square (map x 1).
    expect(getTerrainHeightInterpolated(heights, 62.5, 10.5)).toBe(-256);
    expect(getTerrainHeightInterpolated(heights, 64.5, 10.5)).toBe(-384);
    expect(scene['isInArenaFootprint']([64, 10])).toBe(true);
    expect(scene['isInArenaFootprint']([-1, 10])).toBe(false);
  });

  it('keeps the origin square as the height grid when it is the only arena square', async () => {
    const { scene, mapLoader } = terrainFixture();
    const loaded = new Map<string, MapSquareData>();
    const recordingLoader = {
      loadMapSquare: async (mapX: number, mapY: number) => {
        const map = await mapLoader.loadMapSquare(mapX, mapY);
        loaded.set(`${mapX},${mapY}`, map);
        return map;
      },
    };
    scene.setEncounterRenderConfig({
      terrainMapSquare: { x: 0, y: 0 },
      // The scene draws two squares, but the arena is the origin alone (Inferno's shape).
      mapSquareOffsets: [
        { dx: -1, dy: 0 },
        { dx: 0, dy: 0 },
      ],
      locRender: { levels: [0] },
    });

    await scene.buildTerrainMeshes3D(recordingLoader);

    expect(scene.getTerrainHeights()).toBe(loaded.get('0,0')?.tileHeights[0]);
    expect(scene['isInArenaFootprint']([-1, 10])).toBe(false);
    expect(scene['isInArenaFootprint']([63, 63])).toBe(true);
  });

  it.each([
    'locs-first',
    'terrain-first',
  ])('keeps effective ground raises across rebuilds and resets: %s', async (order) => {
    const { scene, mapLoader } = terrainFixture();
    const cacheInfo = {
      name: 'test',
      game: 'oldschool',
      environment: 'live',
      revision: 232,
      timestamp: '',
      size: 0,
    } as const;
    const loader = new LocModelLoader(cacheInfo, Archive.create(0, new Int8Array([0])), new LegacyCacheIndex(0, []));
    const replacement = new LocType(30, cacheInfo);
    replacement.raise = 96;
    vi.spyOn(loader, 'loadLocType').mockReturnValue(replacement);
    vi.spyOn(scene['locRenderer'], 'load').mockResolvedValue();
    const entries: LocWithType[] = [
      { id: 1, localX: -10, localY: 10, level: 0, type: 22, rotation: 0 },
      { id: 2, localX: -11, localY: 10, level: 0, type: 22, rotation: 0 },
      { id: 3, localX: -9, localY: 10, level: 0, type: 22, rotation: 0 },
      { id: 4, localX: -8, localY: 10, level: 0, type: 22, rotation: 0 },
      { id: 5, localX: -7, localY: 10, level: 0, type: 10, rotation: 0 },
      { id: 6, localX: 8, localY: 8, level: 1, type: 22, rotation: 0 },
      { id: 7, localX: -6, localY: 10, level: 2, type: 22, rotation: 0 },
    ].map((location) => {
      const locType = new LocType(location.id, cacheInfo);
      locType.raise = 32;
      return {
        location,
        locType,
        modelType: LocModelType.FLOOR_DECORATION,
        mapSquareOffset: { x: -64, y: 0 },
        terrainContextOrigin: { x: 6, y: 6 },
        terrainHeightPlanes: [],
      };
    });
    if (order === 'locs-first') await scene.loadLocs(loader, entries);
    await scene.loadTerrain(mapLoader);
    if (order === 'terrain-first') await scene.loadLocs(loader, entries);
    const loadTerrain = vi.spyOn(scene, 'loadTerrain');

    scene.setSmoothTerrain(true);
    await loadTerrain.mock.results[0]?.value;
    scene.resetIntroState();

    expect(scene['resolveSurfaceHeight'](-9.5, 10.5)).toBe(-160);
    expect(scene['resolveSurfaceHeight'](-10.5, 10.5)).toBe(-128);
    expect(scene['resolveSurfaceHeight'](-8.5, 10.5)).toBe(-224);
    expect(scene['resolveSurfaceHeight'](-7.5, 10.5)).toBe(-128);
    expect(scene['resolveSurfaceHeight'](-6.5, 10.5)).toBe(-128);
    expect(scene['resolveSurfaceHeight'](-5.5, 10.5)).toBe(-128);
    expect(scene['resolveSurfaceHeight'](8.5, 8.5)).toBe(-416);
  });

  it('clears scene terrain and raises on permanent disposal', async () => {
    const { scene, mapLoader } = terrainFixture();
    await scene.loadTerrain(mapLoader);
    scene['surfaceHeightResolver'].setGroundDecorations([{ x: 10, y: 10, plane: 0, raise: 32 }]);

    scene.dispose();

    expect(scene['surfaceHeightResolver'].hasTerrain).toBe(false);
    expect(scene['resolveSurfaceHeight'](10.5, 10.5)).toBe(0);
  });
});

describe('SceneCompositor authoritative walkability', () => {
  it('keeps terrain bounds for grid lines when no arena config exists', () => {
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
    const compositor = new TestCompositor();
    compositor.setFallbackGridBounds();

    expect(compositor.gridBounds()).toEqual({ minX: 0, maxX: 63, minY: 0, maxY: 63, width: 64, height: 64 });
    expect(compositor.walkabilityChecker()).toBeNull();
  });

  it.each([
    { name: 'a non-clipping but clipped loc', clipType: 0, expectedWalkable: true },
    { name: 'a default clip type 2 loc', clipType: 2, expectedWalkable: false },
  ])('adopts the simulation walkable set after resolving $name', ({ clipType, expectedWalkable }) => {
    const locType = { clipped: true, clipType, sizeX: 1, sizeY: 1, blocksProjectile: false };
    const analysis = analyzeWalkability(
      makeOpenMapSquare(),
      {
        mapX: 0,
        mapY: 0,
        locations: [{ id: 1, localX: 10, localY: 10, type: LocModelType.NORMAL, rotation: 0, level: 0 }],
      },
      () => locType,
    );
    const compositor = new TestCompositor();

    expect(compositor.walkabilityChecker()).toBeNull();

    setArenaConfig(analysis, false);

    const checker = compositor.walkabilityChecker();
    expect(checker).not.toBeNull();
    if (checker === null) expect.fail('Expected the compositor to adopt the installed arena config');
    expect(checker(10, 10)).toBe(expectedWalkable);
    expect(checker(10, 10)).toBe(analysis.walkableTiles.has('10,10'));
    expect(compositor.gridBounds()).toEqual(analysis.bounds);
    const queue = createQueue();
    compositor.runBoundary(queue);
    expect(queue.commands).not.toHaveLength(0);
  });
});
