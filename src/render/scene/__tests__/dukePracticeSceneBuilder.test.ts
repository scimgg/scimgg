import { afterEach, expect, it, vi } from 'vitest';
import type { AudioEngine } from '../../../audio/AudioEngine';
import { FrameSoundTracker } from '../../../audio/FrameSoundTracker';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { DUKE_BILE_CAPTURE } from '../../../encounters/dukePractice/__tests__/fixtures/dukeBileCapture';
import {
  DUKE_ENRAGED_MAGIC_CAPTURE,
  DUKE_MAGIC_AIM_CAPTURE,
  DUKE_SLAM_CAPTURE,
} from '../../../encounters/dukePractice/__tests__/fixtures/dukeCombatCapture';
import {
  ORB_LANE,
  SLAM_TILES,
  START_TILE,
  square,
  WARDEN_SIZE,
  WARDEN_TILE,
} from '../../../encounters/dukePractice/arena';
import {
  DUKE_ASLEEP_NPC_ID,
  DUKE_NPC_ID,
  DUKE_ORB_NPC_ID,
  DUKE_SEQS,
  DUKE_SPOT_ANIMS,
} from '../../../encounters/dukePractice/constants';
import { ALWAYS_BILE_KEY, BILE_HP, ENRAGE_HP, ORB_HP, VENTS_HP } from '../../../encounters/dukePractice/controls';
import { DukePracticeEncounter } from '../../../encounters/dukePractice/DukePracticeEncounter';
import { DUKE_PRACTICE_RENDER_CONFIG } from '../../../encounters/dukePractice/renderConfig';
import { LEGACY_DUKE_TYPE_ID, WARDEN_ID } from '../../../encounters/dukePractice/warden';
import { LocModelLoader } from '../../../rs/config/loctype/LocModelLoader';
import { ArchiveNpcTypeLoader } from '../../../rs/config/npctype/NpcTypeLoader';
import { IndexModelLoader } from '../../../rs/model/ModelLoader';
import { NpcModelLoader } from '../../../rs/model/NpcModelLoader';
import { openRealCache, skipWithoutRealCache } from '../../../test/helpers/real-cache';
import type { Coordinate } from '../../../types/simulation';
import { DEFAULT_TILE_INDICATOR_CONFIG } from '../../../types/tileIndicators';
import { AnimationSystem } from '../../backends/picogl/AnimationSystem';
import type { NpcMesh3DCommand } from '../../core/commands';
import { typeEntry } from '../../npc/__tests__/npcFacingTestHarness';
import { PRIMARY_NPC_ACTOR_ID } from '../../npc/NpcInstanceManager';
import { Projection3D } from '../../projections/Projection3D';
import { DukePracticeEffects } from '../dukePracticeEffects';
import { DukePracticeSceneCompositor } from '../dukePracticeSceneBuilder';
import type { SceneOptions } from '../types';

const options: SceneOptions = {
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
};
const arena = getArenaConfig();
const unbounded = getArenaAllowUnboundedFallback();
afterEach(() => {
  setArenaConfig(arena, unbounded);
  vi.restoreAllMocks();
});

it.each<Coordinate>([
  [27, 51],
  [31, 51],
  [35, 51],
])('draws the captured frontal row when the player is at (%i, %i)', (x, y) => {
  const scene = new DukePracticeSceneCompositor();
  try {
    const renderer = scene['spotAnimRenderer'];
    vi.spyOn(renderer, 'isLoaded').mockReturnValue(true);
    vi.spyOn(renderer, 'getFrameLengths').mockReturnValue([90]);
    const upsert = vi.spyOn(renderer, 'upsert');
    new DukePracticeEffects().update(
      renderer,
      { hazards: [{ kind: 'spikes', tiles: square([x, y], 1), impactTick: 7, expiresTick: 8 }], orbTile: null },
      7,
      [x, y],
    );

    const [frontal, ...ground] = upsert.mock.calls.map(([request]) => request);
    expect(ground.map(({ spotAnimId }) => spotAnimId)).toEqual(DUKE_SLAM_CAPTURE.frontRowGraphics);
    for (const [index, { transform, lifecycle }] of ground.entries()) {
      if (transform.kind !== 'dynamic') throw new Error('Expected a tile transform for each ground graphic');
      expect(transform.resolve(7, 7, null)?.position.slice(0, 2)).toEqual(SLAM_TILES[index].map((axis) => axis + 0.5));
      expect(lifecycle).toMatchObject({ kind: 'oneShot', startTick: 7 });
    }
    const { spotAnimId, lifecycle, transform } = frontal;
    expect(spotAnimId).toBe(DUKE_SPOT_ANIMS.npcIcicles);
    expect(lifecycle).toMatchObject({ kind: 'oneShot', startTick: 7 });
    if (transform.kind !== 'dynamic') throw new Error('Expected a dynamic transform for the icicles');
    expect(transform.resolve(7, 7, null)?.position.slice(0, 2)).toEqual([
      WARDEN_TILE[0] + WARDEN_SIZE / 2,
      WARDEN_TILE[1] + WARDEN_SIZE / 2,
    ]);
  } finally {
    scene.dispose();
  }
});

it.each([true, false])('respects true-tile visibility %s while hiding melee tile fills', (enabled) => {
  const engine = new SimulationEngine({ encounter: new DukePracticeEncounter() });
  const playerTile: Coordinate = [31, 51];
  engine.setAttackTarget(WARDEN_ID);
  engine.advanceTick(playerTile);
  engine.setAttackTarget(null);
  while (engine.currentTick < 6) engine.advanceTick(playerTile);

  const state = engine.getState();
  expect(state.encounter).toMatchObject({
    visuals: {
      hazards: expect.arrayContaining([
        expect.objectContaining({ kind: 'spikes' }),
        expect.objectContaining({ kind: 'slam' }),
      ]),
    },
  });

  const scene = new DukePracticeSceneCompositor();
  try {
    scene['terrainHeights'] = Array.from({ length: 65 }, () => new Int32Array(65));
    const viewport = { width: 800, height: 600, dpr: 1 };
    const projection = new Projection3D(viewport, {
      yaw: 0,
      pitch: -57,
      fovScale: 235,
      targetX: 31.5,
      targetY: 51.5,
    });
    const queue = scene.build(
      {
        simulationState: state,
        events: [],
        options: {
          ...options,
          renderMode: '3d',
          tileIndicatorConfig: {
            ...DEFAULT_TILE_INDICATOR_CONFIG,
            trueTile: { ...DEFAULT_TILE_INDICATOR_CONFIG.trueTile, enabled },
          },
        },
        interaction: { hoveredTile: [30, 50], targetTile: null },
        interpolatedTick: engine.currentTick,
        speedMultiplier: 1,
      },
      projection,
      viewport,
    );
    const meshIds = queue.commands.flatMap((command) => (command.kind === 'mesh3d' ? [command.meshId] : []));
    expect(meshIds).toContainEqual(expect.stringMatching(/^corner-outline-30-50-/));
    expect(meshIds.some((id) => id.startsWith('outline-31-51-31-51-'))).toBe(enabled);
    expect(meshIds).not.toContainEqual(expect.stringMatching(/^duke-practice-(spikes|slam)-/));
  } finally {
    scene.dispose();
  }
});

it('continues the windup graphics without adding a second effect on the slam tick', () => {
  const scene = new DukePracticeSceneCompositor();
  try {
    const renderer = scene['spotAnimRenderer'];
    vi.spyOn(renderer, 'isLoaded').mockReturnValue(true);
    vi.spyOn(renderer, 'getFrameLengths').mockReturnValue([90]);
    const upsert = vi.spyOn(renderer, 'upsert');
    new DukePracticeEffects().update(
      renderer,
      {
        hazards: [{ kind: 'slam', tiles: [[31, 51]], impactTick: 9, expiresTick: 10 }],
        fadingEffects: [{ kind: 'spikes', tiles: square([31, 51], 1), impactTick: 7, expiresTick: 8 }],
        orbTile: null,
      },
      9,
      [27, 51],
    );
    expect(upsert.mock.calls.map(([request]) => request.spotAnimId)).toEqual([
      DUKE_SPOT_ANIMS.npcIcicles,
      ...DUKE_SLAM_CAPTURE.frontRowGraphics,
    ]);
  } finally {
    scene.dispose();
  }
});

it('restarts one cloud when a flare lands on the same grate and fades each grate separately', () => {
  const engine = new SimulationEngine({
    encounter: new DukePracticeEncounter(),
    mechanics: { infiniteHealth: true },
  });
  engine.setBossHp(VENTS_HP);
  const playerTile: Coordinate = [31, 51];
  engine.setAttackTarget(WARDEN_ID);
  engine.advanceTick(playerTile);
  engine.setAttackTarget(null);

  const scene = new DukePracticeSceneCompositor();
  try {
    scene['terrainHeights'] = Array.from({ length: 65 }, () => new Int32Array(65));
    const renderer = scene['spotAnimRenderer'];
    vi.spyOn(renderer, 'isLoaded').mockReturnValue(true);
    vi.spyOn(renderer, 'getFrameLengths').mockImplementation((id) =>
      id === DUKE_SPOT_ANIMS.ventDespawn ? [30] : [60],
    );
    const upsert = vi.spyOn(renderer, 'upsert');
    const viewport = { width: 800, height: 600, dpr: 1 };
    const projection = new Projection3D(viewport);
    const firstFlareTick = 52;
    for (const [offset, graphic, grateX = 31] of [
      [0, null],
      [1, DUKE_SPOT_ANIMS.spitProjectile],
      [3, DUKE_SPOT_ANIMS.ventSpawn],
      [4, DUKE_SPOT_ANIMS.ventIdle],
      [6, DUKE_SPOT_ANIMS.ventSpawn, 28],
      [7, DUKE_SPOT_ANIMS.ventIdle, 28],
      [8, DUKE_SPOT_ANIMS.ventSpawn, 28],
      [9, DUKE_SPOT_ANIMS.ventIdle, 28],
      [17, DUKE_SPOT_ANIMS.ventIdle],
      [18, DUKE_SPOT_ANIMS.ventDespawn],
      [19, null],
      [22, DUKE_SPOT_ANIMS.ventIdle, 28],
      [23, DUKE_SPOT_ANIMS.ventDespawn, 28],
      [24, null, 28],
    ] as const) {
      const tick = firstFlareTick + offset;
      while (engine.currentTick < tick) engine.advanceTick(playerTile);
      upsert.mockClear();
      const queue = scene.build(
        {
          simulationState: engine.getState(),
          events: [],
          options: { ...options, renderMode: '3d' },
          interaction: { hoveredTile: null, targetTile: null },
          interpolatedTick: tick,
          speedMultiplier: 1,
        },
        projection,
        viewport,
      );
      const ventUpdates = upsert.mock.calls
        .map(([request]) => request)
        .filter(({ instanceId }) =>
          instanceId?.startsWith(offset <= 1 ? 'duke-vent-' : `duke-vent-cloud-${grateX}-50-`),
        );
      expect(ventUpdates.map(({ spotAnimId }) => spotAnimId)).toEqual(graphic === null ? [] : [graphic]);
      if (offset === 1) {
        const { transform } = ventUpdates[0];
        if (transform.kind !== 'dynamic') throw new Error('Expected a dynamic flare');
        const landingTick = firstFlareTick + 3;
        expect(transform.resolve(landingTick, landingTick, null)?.position).toEqual([31.5, 50.5, 0]);
        expect(upsert.mock.calls.some(([request]) => request.spotAnimId === DUKE_SPOT_ANIMS.magicProjectile)).toBe(
          false,
        );
      }
      if (offset === 22) {
        expect(ventUpdates[0]).toMatchObject({
          lifecycle: { kind: 'duration', endTick: firstFlareTick + 23 },
          frameProgress: 0.5,
        });
      }
      expect(
        queue.commands.some((command) => command.kind === 'mesh3d' && command.meshId.startsWith('duke-practice-vent-')),
      ).toBe(false);
    }
  } finally {
    scene.dispose();
  }
});

it.skipIf(skipWithoutRealCache('pinned'))(
  'draws cache acid pools on the bile trail until each tile expires',
  async () => {
    const { cache, info } = await openRealCache([2, 7], 'pinned');
    const engine = new SimulationEngine({
      encounter: new DukePracticeEncounter(),
      mechanics: { [ALWAYS_BILE_KEY]: true, infiniteHealth: true },
    });
    engine.setBossHp(BILE_HP);
    const scene = new DukePracticeSceneCompositor();
    const viewport = { width: 800, height: 600, dpr: 1 };
    const projection = new Projection3D(viewport);
    const renderPools = () => {
      const queue = scene.build(
        {
          simulationState: engine.getState(),
          events: [],
          options: { ...options, renderMode: '3d' },
          interaction: { hoveredTile: null, targetTile: null },
          interpolatedTick: engine.currentTick,
          speedMultiplier: 1,
        },
        projection,
        viewport,
      );
      expect(
        queue.commands.some((command) => command.kind === 'mesh3d' && command.meshId.startsWith('duke-practice-bile-')),
      ).toBe(false);
      return queue.commands.flatMap((command) =>
        command.kind === 'mesh3d' && command.meshId === 'scene-object-loc:30032:10:0:-1-frame-0-opaque'
          ? [Array.from(command.modelMatrix.slice(12, 14))]
          : [],
      );
    };

    try {
      scene.setEncounterRenderConfig(DUKE_PRACTICE_RENDER_CONFIG);
      scene['terrainHeights'] = Array.from({ length: 65 }, () => new Int32Array(65));
      scene['setSceneObjectLocModelLoader'](
        new LocModelLoader(info, cache.getIndex(2).getArchive(6), cache.getIndex(7)),
      );

      const cover: Coordinate = [27, 51];
      const bileTick = 63;
      engine.setAttackTarget(WARDEN_ID);
      engine.advanceTick([31, 51]);
      engine.setAttackTarget(null);
      while (engine.currentTick < bileTick) engine.advanceTick(cover);

      const firstPool = cover.map((axis) => axis + 0.5);
      engine.applyAction({ type: 'runToggle' });
      expect(renderPools()).toEqual([]);
      engine.advanceTick([28, 50]);
      expect(renderPools()).toEqual([firstPool]);
      engine.advanceTick([29, 49]);
      expect(renderPools()).toEqual([firstPool, [28.5, 50.5]]);

      while (engine.currentTick < bileTick + 10) engine.advanceTick([29, 49]);
      expect(renderPools()).toEqual([
        [28.5, 50.5],
        [29.5, 49.5],
      ]);
      while (engine.currentTick < bileTick + 17) engine.advanceTick([29, 49]);
      expect(renderPools()).toEqual([[29.5, 49.5]]);
      while (engine.currentTick < bileTick + 21) engine.advanceTick([29, 49]);
      expect(renderPools()).toEqual([]);
    } finally {
      scene.dispose();
    }
  },
);

it('aims the blue bolt and its impact at the rendered player during movement', () => {
  const { launch, impact } = DUKE_MAGIC_AIM_CAPTURE;
  const { launchCycle, arrivalCycle } = DUKE_ENRAGED_MAGIC_CAPTURE;
  const engine = new SimulationEngine({
    encounter: new DukePracticeEncounter(),
    combatRandom: () => 0,
  });
  engine.setBossHp(ENRAGE_HP);
  engine.setAttackTarget(WARDEN_ID);
  engine.advanceTick([31, 51]);
  engine.setAttackTarget(null);
  while (engine.currentTick < 7) engine.advanceTick(launch.trueTile);

  const scene = new DukePracticeSceneCompositor();
  try {
    const renderer = scene['spotAnimRenderer'];
    vi.spyOn(renderer, 'isLoaded').mockReturnValue(true);
    vi.spyOn(renderer, 'getFrameLengths').mockReturnValue([90]);
    const upsert = vi.spyOn(renderer, 'upsert');
    const viewport = { width: 800, height: 600, dpr: 1 };
    const projection = new Projection3D(viewport);
    const draw = (time: number, position: Coordinate, simulationState = engine.getState()) => {
      upsert.mockClear();
      scene.build(
        {
          simulationState,
          events: [],
          options: { ...options, renderMode: '3d' },
          interaction: { hoveredTile: null, targetTile: null },
          interpolatedTick: time,
          speedMultiplier: 1,
          playerVisual: {
            position,
            isVisuallyMoving: true,
            simIsMoving: true,
            isRunning: true,
            locomotionState: null,
            facingAngle: 512,
            targetAngle: 512,
            isTurning: false,
          },
        },
        projection,
        viewport,
      );
    };
    const effect = (spotAnimId: number) =>
      upsert.mock.calls.find(([request]) => request.spotAnimId === spotAnimId)?.[0];

    draw(7.6, launch.visibleTile);
    expect(effect(DUKE_SPOT_ANIMS.magicProjectile)).toBeUndefined();
    engine.advanceTick(launch.trueTile);
    expect(engine.getState().playerPosition).toEqual(launch.trueTile);
    draw(8, launch.visibleTile);
    const projectile = effect(DUKE_SPOT_ANIMS.magicProjectile);
    expect(projectile?.lifecycle).toEqual({
      kind: 'duration',
      startTick: 6 + launchCycle / 30,
      endTick: 6 + arrivalCycle / 30,
    });
    if (projectile?.transform.kind !== 'static') throw new Error('Expected a sampled projectile');
    const movingPlayer: Coordinate = [29.75, 50.25];
    draw(8, movingPlayer);
    expect(effect(DUKE_SPOT_ANIMS.magicProjectile)?.transform).toEqual(projectile.transform);

    draw(9.999, movingPlayer);
    const movingProjectile = effect(DUKE_SPOT_ANIMS.magicProjectile);
    if (movingProjectile?.transform.kind !== 'static') throw new Error('Expected a sampled projectile');
    const [x, y, z] = movingProjectile.transform.value.position;
    expect(x).toBeCloseTo(30.25);
    expect(y).toBeCloseTo(50.75);
    expect(z).toBeCloseTo(100 / 128);

    while (engine.currentTick < 10) engine.advanceTick(impact.trueTile);
    const hitState = engine.getState();
    expect(hitState.playerPosition).toEqual(impact.trueTile);
    draw(10, impact.visibleTile);
    expect(effect(DUKE_SPOT_ANIMS.magicProjectile)).toBeUndefined();
    const graphic = effect(DUKE_SPOT_ANIMS.magicImpact);
    if (graphic?.transform.kind !== 'dynamic') throw new Error('Expected a dynamic impact graphic');
    expect(graphic.transform.resolve(10, 10, null)?.position.slice(0, 2)).toEqual([29.5, 51.5]);

    draw(10.25, [28.25, 51]);
    const movingGraphic = effect(DUKE_SPOT_ANIMS.magicImpact);
    if (movingGraphic?.transform.kind !== 'dynamic') throw new Error('Expected a dynamic impact graphic');
    expect(movingGraphic.transform.resolve(10, 10.25, null)?.position.slice(0, 2)).toEqual([28.75, 51.5]);

    if (hitState.encounter.kind !== 'duke_practice') throw new Error('Expected Duke encounter');
    draw(10.5, impact.trueTile, {
      ...hitState,
      encounter: {
        ...hitState.encounter,
        visuals: {
          ...hitState.encounter.visuals,
          hazards: hitState.encounter.visuals.hazards.map((hazard) => ({ ...hazard, missed: true })),
        },
      },
    });
    expect(effect(DUKE_SPOT_ANIMS.magicImpact)).toBeUndefined();
  } finally {
    scene.dispose();
  }
});

it('renders the captured bile projectile during its flight and removes it at arrival', () => {
  const scene = new DukePracticeSceneCompositor();
  try {
    const renderer = scene['spotAnimRenderer'];
    vi.spyOn(renderer, 'getFrameLengths').mockReturnValue([40]);
    const upsert = vi.spyOn(renderer, 'upsert');
    const despawn = vi.spyOn(renderer, 'despawn');
    const effects = new DukePracticeEffects();
    const visuals = { hazards: [], orbTile: null, pose: { clip: 'bile', startTick: 22 } } as const;
    const playerTile: Coordinate = [31, 51];
    const projectile = DUKE_BILE_CAPTURE.projectile;
    const launch = 22 + projectile.startCycle / 30;
    const arrival = 22 + projectile.endCycle / 30;

    const duke = DUKE_PRACTICE_RENDER_CONFIG.preloadNpcTypes?.find(({ npcTypeId }) => npcTypeId === DUKE_NPC_ID);
    expect(duke?.attackClips?.bile).toBe(DUKE_BILE_CAPTURE.sequenceId);
    effects.update(renderer, visuals, launch - 1 / 30, playerTile);
    expect(upsert).not.toHaveBeenCalled();
    effects.update(renderer, visuals, launch, playerTile);
    const [request] = upsert.mock.calls[0];
    expect(request).toMatchObject({
      spotAnimId: projectile.id,
      projectile: true,
      lifecycle: { kind: 'duration', startTick: launch, endTick: arrival },
      frameProgress: 0,
    });
    if (request.transform.kind !== 'dynamic') throw new Error('Expected a dynamic transform for the bile');
    expect(request.transform.resolve(23, launch, null)?.position).toEqual([
      31.5,
      53.5 - projectile.startOffset / 128,
      projectile.startHeight / 128,
    ]);
    expect(request.transform.resolve(23, arrival, null)?.position).toEqual([31.5, 51.5, projectile.endHeight / 128]);

    upsert.mockClear();
    effects.update(renderer, visuals, arrival, playerTile);
    expect(upsert).not.toHaveBeenCalled();
    expect(despawn).toHaveBeenCalledWith(request.instanceId);
  } finally {
    scene.dispose();
  }
});

it.each([
  DUKE_NPC_ID,
  LEGACY_DUKE_TYPE_ID,
])('renders awake snapshot type %i with the same Duke model between sleeping snapshots', (awakeSnapshotType) => {
  const engine = new SimulationEngine({ encounter: new DukePracticeEncounter() });
  const sleepingSnapshots = engine.getState().npcs;
  const scene = new DukePracticeSceneCompositor();
  try {
    scene.setEncounterRenderConfig(DUKE_PRACTICE_RENDER_CONFIG);
    const manager = scene['npcInstanceManager'];
    const types = manager['typeRegistry'];
    for (const id of [DUKE_ASLEEP_NPC_ID, DUKE_NPC_ID]) types.set(id, typeEntry(id, WARDEN_SIZE, 32));
    const instances = manager['instanceRegistry'];

    scene['syncNpcInstances'](sleepingSnapshots, false);
    expect(instances.get(PRIMARY_NPC_ACTOR_ID)?.npcTypeId).toBe(DUKE_ASLEEP_NPC_ID);
    scene['syncNpcInstances']([{ ...sleepingSnapshots[0], npcTypeId: awakeSnapshotType }], false);
    expect(instances.get(PRIMARY_NPC_ACTOR_ID)?.npcTypeId).toBe(DUKE_NPC_ID);
    scene['syncNpcInstances'](sleepingSnapshots, false);
    expect(instances.get(PRIMARY_NPC_ACTOR_ID)?.npcTypeId).toBe(DUKE_ASLEEP_NPC_ID);
  } finally {
    scene.dispose();
  }
});

it.skipIf(skipWithoutRealCache('pinned'))(
  'plays Duke’s cache breathing while asleep and stops when he wakes',
  async () => {
    const { cache, info } = await openRealCache([0, 1, 2, 7, 22], 'pinned');
    const configs = cache.getIndex(2);
    const models = new IndexModelLoader(cache.getIndex(7));
    const npcs = new NpcModelLoader(new ArchiveNpcTypeLoader(info, configs.getArchive(9)), models);
    const animation = new AnimationSystem();
    animation.initialize(info, cache.getIndex(0), cache.getIndex(1), configs.getArchive(12), cache.getIndex(22));
    const play = vi.fn();
    const scene = new DukePracticeSceneCompositor(
      () => models,
      new FrameSoundTracker({ play } as unknown as AudioEngine),
    );
    const engine = new SimulationEngine({
      encounter: new DukePracticeEncounter(),
      mechanics: { infiniteHealth: true },
    });
    const viewport = { width: 800, height: 600, dpr: 1 };
    const projection = new Projection3D(viewport);
    const draw = () => {
      scene.build(
        {
          simulationState: engine.getState(),
          events: engine.getLastTickEvents(),
          options: { ...options, renderMode: '3d' },
          interaction: { hoveredTile: null, targetTile: null },
          interpolatedTick: engine.currentTick,
          speedMultiplier: 1,
        },
        projection,
        viewport,
      );
    };
    try {
      scene.setEncounterRenderConfig(DUKE_PRACTICE_RENDER_CONFIG);
      await scene.loadNpc(npcs, animation);
      draw();
      for (let i = 0; i < 3; i++) {
        engine.advanceTick([31, 51]);
        draw();
      }
      // Pinned sequence 10174 frames 1, 56 and 57. See 20261126-235612-Duke-Sucellus.jsonl:6184–6218.
      expect(play.mock.calls.map(([id]) => id)).toEqual([7192, 7237, 7172]);
      expect(play.mock.calls.every(([, sound]) => sound.channel === 'area')).toBe(true);

      play.mockClear();
      engine.setAttackTarget(WARDEN_ID);
      engine.advanceTick([31, 51]);
      engine.setAttackTarget(null);
      draw();
      for (let i = 0; i < 6; i++) {
        engine.advanceTick([31, 51]);
        draw();
      }
      expect(engine.getState().npcs[0].npcTypeId).toBe(DUKE_NPC_ID);
      expect(play).not.toHaveBeenCalled();
    } finally {
      scene.dispose();
      animation.dispose();
    }
  },
);

it.skipIf(skipWithoutRealCache('pinned'))(
  'animates the cache eye and screen overlay during Freezing Gaze',
  async () => {
    const { cache, info } = await openRealCache([0, 1, 2, 7, 22], 'pinned');
    const configs = cache.getIndex(2);
    const models = new IndexModelLoader(cache.getIndex(7));
    const npcs = new NpcModelLoader(new ArchiveNpcTypeLoader(info, configs.getArchive(9)), models);
    const animation = new AnimationSystem();
    animation.initialize(info, cache.getIndex(0), cache.getIndex(1), configs.getArchive(12), cache.getIndex(22));
    const scene = new DukePracticeSceneCompositor(() => models);
    try {
      scene.setEncounterRenderConfig(DUKE_PRACTICE_RENDER_CONFIG);
      await scene.loadNpc(npcs, animation);
      const engine = new SimulationEngine({
        encounter: new DukePracticeEncounter(),
        mechanics: { infiniteHealth: true },
      });
      const tile: Coordinate = [27, 51];
      engine.setAttackTarget(WARDEN_ID);
      engine.advanceTick([31, 51]);
      engine.setAttackTarget(null);

      const viewport = { width: 800, height: 600, dpr: 1 };
      const projection = new Projection3D(viewport);
      const sampleOverlay = (tick: number) => {
        while (engine.currentTick < tick) engine.advanceTick(tile);
        const queue = scene.build(
          {
            simulationState: engine.getState(),
            events: engine.getLastTickEvents(),
            options: { ...options, renderMode: '3d' },
            interaction: { hoveredTile: null, targetTile: null },
            interpolatedTick: tick,
            speedMultiplier: 1,
          },
          projection,
          viewport,
        );
        return queue.commands.find((command) => command.kind === 'mesh3d' && command.clipSpace) as
          | NpcMesh3DCommand
          | undefined;
      };

      expect(sampleOverlay(30)).toBeUndefined();
      const start = sampleOverlay(31);
      expect(scene['collectActorFrameStates']()).toContainEqual(expect.objectContaining({ seqId: DUKE_SEQS.gaze }));
      const brighter = sampleOverlay(34);
      const fading = sampleOverlay(36);
      expect(start?.meshId).toMatch(/^duke-gaze-overlay-/);
      expect(brighter?.perVertexAlphas).toBeDefined();
      const peakAlpha = (mesh?: NpcMesh3DCommand) => Math.max(...(mesh?.perVertexAlphas ?? []));
      expect(peakAlpha(brighter)).toBeGreaterThan(peakAlpha(start));
      expect(peakAlpha(fading)).toBeLessThan(peakAlpha(brighter));
      expect(sampleOverlay(37)).toBeUndefined();
    } finally {
      scene.dispose();
      animation.dispose();
    }
  },
);

it.skipIf(skipWithoutRealCache('pinned'))(
  'plays the unscaled cache slam in live and replay views through a safe re-entry',
  async () => {
    const { cache, info } = await openRealCache([0, 1, 2, 7, 22], 'pinned');
    const configs = cache.getIndex(2);
    const models = new IndexModelLoader(cache.getIndex(7));
    const npcs = new NpcModelLoader(new ArchiveNpcTypeLoader(info, configs.getArchive(9)), models);
    const animation = new AnimationSystem();
    animation.initialize(info, cache.getIndex(0), cache.getIndex(1), configs.getArchive(12), cache.getIndex(22));
    const scene = new DukePracticeSceneCompositor(() => models);
    try {
      scene.setEncounterRenderConfig(DUKE_PRACTICE_RENDER_CONFIG);
      await scene.loadNpc(npcs, animation);
      const engine = new SimulationEngine({ encounter: new DukePracticeEncounter() });
      const bait: Coordinate = [31, 51];
      engine.setAttackTarget(WARDEN_ID);
      engine.advanceTick(bait);
      engine.applyAction({ type: 'attackTarget', targetId: null });
      while (engine.currentTick < 6) engine.advanceTick(bait);

      const viewport = { width: 800, height: 600, dpr: 1 };
      const projection = new Projection3D(viewport);
      const draw = (time: number, replay = false) => {
        const state = engine.getState();
        const events = engine.getLastTickEvents();
        scene.build(
          {
            simulationState: state,
            events,
            options: { ...options, renderMode: '3d' },
            interaction: { hoveredTile: null, targetTile: null },
            interpolatedTick: time,
            speedMultiplier: 1,
            ...(replay
              ? {
                  replayHistory: { frames: [{ state, events }], throughFrameIndex: 0 },
                  timeline: { timelineKey: 'review', paused: true, timeMs: time * 600 },
                }
              : {}),
          },
          projection,
          viewport,
        );
        return scene['collectActorFrameStates']().find(({ actorId }) => actorId === PRIMARY_NPC_ACTOR_ID);
      };

      expect(draw(6)).toMatchObject({ seqId: DUKE_SEQS.slam, currentFrame: 0 });
      engine.advanceTick(START_TILE);
      expect(engine.getState().playerPosition).toEqual(START_TILE);
      expect(draw(7)).toMatchObject({ seqId: DUKE_SEQS.slam, currentFrame: 30 });
      // Cache 2772, seq 10176. Frame 41 carries the hand-impact cue (7224).
      expect(draw(7.35)).toMatchObject({ seqId: DUKE_SEQS.slam, currentFrame: 40 });
      expect(draw(7.38)).toMatchObject({ seqId: DUKE_SEQS.slam, currentFrame: 41 });
      expect(draw(7.38, true)).toMatchObject({ seqId: DUKE_SEQS.slam, currentFrame: 41 });

      engine.applyAction({ type: 'attackTarget', targetId: WARDEN_ID });
      engine.advanceTick(START_TILE);
      expect(engine.getState().playerPosition).toEqual(bait);
      expect(draw(8, true)).toMatchObject({ seqId: DUKE_SEQS.slam, currentFrame: 60 });
      expect(engine.getState().damageHistory).not.toContainEqual(expect.objectContaining({ source: 'Slam' }));
    } finally {
      scene.dispose();
      animation.dispose();
    }
  },
);

it('glides the cache orb in both directions and plays the burst at both ends of the sweep', () => {
  const engine = new SimulationEngine({
    encounter: new DukePracticeEncounter(57),
    mechanics: { infiniteHealth: true },
  });
  engine.setBossHp(ORB_HP);
  const scene = new DukePracticeSceneCompositor();
  const mesh: NpcMesh3DCommand = {
    kind: 'mesh3d',
    meshId: 'orb-fixture',
    materialId: 'orb-fixture',
    modelMatrix: new Float32Array(16),
    positions: new Float32Array(),
    normals: new Float32Array(),
  };
  try {
    scene.setEncounterRenderConfig(DUKE_PRACTICE_RENDER_CONFIG);
    const renderer = scene['spotAnimRenderer'];
    vi.spyOn(renderer, 'isLoaded').mockReturnValue(true);
    vi.spyOn(renderer, 'getFrameLengths').mockReturnValue([48]);
    const upsert = vi.spyOn(renderer, 'upsert');
    const types = scene['npcInstanceManager']['typeRegistry'];
    for (const id of [DUKE_ASLEEP_NPC_ID, DUKE_NPC_ID]) types.set(id, typeEntry(id, WARDEN_SIZE, 32));
    types.set(DUKE_ORB_NPC_ID, {
      ...typeEntry(DUKE_ORB_NPC_ID, 1, 0),
      baseMeshCommands: [mesh],
    });
    const viewport = { width: 800, height: 600, dpr: 1 };
    const projection = new Projection3D(viewport);
    const tilePolygonScreen = vi.spyOn(projection, 'tilePolygonScreen');
    const draw = (interpolatedTick: number, renderMode: '2d' | '3d') =>
      scene.build(
        {
          simulationState: engine.getState(),
          events: [],
          options: { ...options, renderMode },
          interaction: { hoveredTile: null, targetTile: null },
          interpolatedTick,
          speedMultiplier: 1,
        },
        projection,
        viewport,
      );
    engine.setAttackTarget(WARDEN_ID);
    engine.advanceTick([31, 51]);
    engine.setAttackTarget(null);
    for (const [tick, fraction, x, burstTicks] of [
      [9, 0.5, null, []],
      [10, 0.5, ORB_LANE.east, [10]],
      [11, 0.5, ORB_LANE.east - 0.5, [10]],
      [20, 1, ORB_LANE.west, []],
      [21, 0, null, [21]],
      [22, 0.5, ORB_LANE.west, [21, 22]],
      [23, 0.5, ORB_LANE.west + 0.5, [22]],
    ] as const) {
      for (let next = engine.currentTick; next < tick; next++) engine.advanceTick(START_TILE);
      expect(engine.currentTick).toBe(tick);
      upsert.mockClear();
      const queue = draw(tick + fraction, '3d');
      const centers = queue.commands.flatMap((command) =>
        command.kind === 'mesh3d' && command.meshId.startsWith(mesh.meshId)
          ? [[command.modelMatrix[12], command.modelMatrix[13]]]
          : [],
      );
      expect(centers).toEqual(x === null ? [] : [[x + 0.5, ORB_LANE.y + 0.5]]);

      const bursts = upsert.mock.calls.flatMap(([request]) => {
        if (
          request.spotAnimId !== DUKE_SPOT_ANIMS.orbBurst ||
          request.transform.kind !== 'dynamic' ||
          request.lifecycle.kind !== 'oneShot'
        )
          return [];
        return [[request.lifecycle.startTick, request.transform.resolve(tick, tick, null)?.position.slice(0, 2)]];
      });
      expect(bursts).toEqual(
        burstTicks.map((startTick) => [
          startTick,
          [(startTick === 10 ? ORB_LANE.east : ORB_LANE.west) + 0.5, ORB_LANE.y + 0.5],
        ]),
      );
      if (x !== null && !Number.isInteger(x)) {
        tilePolygonScreen.mockClear();
        draw(tick + fraction, '2d');
        expect(tilePolygonScreen).toHaveBeenCalledWith({ x, y: ORB_LANE.y });
      }
    }
  } finally {
    scene.dispose();
  }
});
