import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, FrameSoundTracker } from '../../../audio';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import type { EncounterVisualEvent } from '../../../core/events/encounterVisual';
import type { GameEvent } from '../../../core/events/types';
import { type ReplayDisplayFrame, ReplayRecorder, type ReplayRecorderData } from '../../../core/ReplayRecorder';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { SOL_HEREDIT_RENDER_CONFIG } from '../../../encounters/solHeredit/renderConfig';
import { SolHereditEncounter } from '../../../encounters/solHeredit/SolHereditEncounter';
import {
  COLOSSEUM_SPOTANIMS,
  HEALING_TOTEM_PROJECTILE,
  SOL_ACTOR_ID,
  SOL_NPC_ID,
  WARBAND_BERSERKER_NPC_ID,
} from '../../../npcs/colosseum/constants';
import { COLOSSEUM_SPOT_ANIM_IDS, colosseumBeamGraphics } from '../../../npcs/colosseum/visualEvents';
import { ReplayPresentationStateSchema } from '../../../replay/format/presentationFormat';
import { SeqType } from '../../../rs/config/seqtype/SeqType';
import { LEGACY_SOL, legacySolRecording } from '../../../test/helpers/legacyEncounterRecordings';
import { validPresentationSample } from '../../../test/helpers/replayFixtures';
import {
  activeWindows,
  installSyntheticSpotAnims,
  observeScene,
  replayContextAt,
  SCENE_OPTIONS,
  type SceneObservation,
  syntheticNpcAssets,
  VIEWPORT,
} from '../../../test/helpers/sceneObservation';
import type { RestoredPresentation } from '../../../types/restoredPresentation';
import type { Coordinate } from '../../../types/simulation';
import { perfFlags } from '../../../util/PerfFlags';
import type { Projection2D } from '../../core/camera';
import type { NpcMesh3DCommand } from '../../core/commands';
import { createSpotAnimMeshParts } from '../../effects/spotAnimMeshParts';
import { FLOOR_EFFECT_DEPTH_BIAS } from '../../effects/spotAnimRenderPolicy';
import { seed } from '../../npc/__tests__/npcFacingTestHarness';
import type { FrameClipRef, NpcAnimationSet } from '../../npc/animationTypes';
import { NpcAnimationController } from '../../npc/NpcAnimationController';
import { PRIMARY_NPC_ACTOR_ID } from '../../npc/NpcInstanceManager';
import { ColosseumSceneCompositor, type ColosseumSceneOptions } from '../ColosseumSceneCompositor';
import { SceneCompositor } from '../SceneCompositor';
import { createSolHereditSceneBuilder } from '../solHereditSceneBuilder';
import type { RenderContext } from '../types';

const projection: Projection2D = {
  tileToScreen: (tile) => tile,
  tileDeltaToScreen: (delta) => delta,
  screenToTile: () => null,
  tilePolygonScreen: () => [],
};
const scenes: ColosseumSceneCompositor[] = [];
const arena = getArenaConfig();
const unbounded = getArenaAllowUnboundedFallback();
const initialSkipTransparentSort = perfFlags.skipTransparentSort;
afterEach(() => {
  for (const scene of scenes) scene.dispose();
  scenes.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setArenaConfig(arena, unbounded);
  perfFlags.skipTransparentSort = initialSkipTransparentSort;
});

function clip(id: string, frameId: number): FrameClipRef {
  return {
    kind: 'frame',
    id,
    seqId: frameId,
    seqType: new SeqType(frameId, {
      name: 'test',
      game: 'oldschool',
      environment: 'test',
      revision: 0,
      timestamp: '',
      size: 0,
    }),
    frameIds: [frameId],
    frameLengths: [120],
  };
}

/**
 * Sol's scene with Sol seeded. `settled` (the default) settles every other declared asset as one the
 * cache could not supply, as a replay needs before it reconstructs; `pending` leaves the other NPC
 * types loading.
 */
function fixture(options?: ColosseumSceneOptions, assets: 'settled' | 'pending' = 'settled') {
  const scene = new ColosseumSceneCompositor(options);
  scenes.push(scene);
  scene.setEncounterRenderConfig(SOL_HEREDIT_RENDER_CONFIG);
  const manager = scene['npcInstanceManager'];
  seed(manager, {
    actorId: PRIMARY_NPC_ACTOR_ID,
    npcTypeId: SOL_NPC_ID,
    position: [30, 30],
    size: 5,
    facing: 0,
    rotationSpeed: 32,
  });
  const animationSet: NpcAnimationSet = {
    idle: clip('idle', 1),
    attackClips: { spear: clip('spear', 2), shield: clip('shield', 3), grapple: clip('grapple', 5) },
  };
  const controller = new NpcAnimationController({
    animationSet,
    modelAdapter: {
      resetPose() {},
      applyFrame() {},
      applySkeletal() {},
      applyFrameInterleaved() {},
      resize() {},
      commitPose() {},
    },
  });
  const instance = manager['instanceRegistry'].get(PRIMARY_NPC_ACTOR_ID);
  const type = manager['typeRegistry'].get(SOL_NPC_ID);
  if (!instance || !type) throw new Error('missing seeded actor');
  instance.animController = controller;
  type.animationSet = animationSet;
  if (assets === 'settled') {
    settleNpcTypes(scene);
    const effects = scene['spotAnimRenderer']['meshCache'];
    for (const spotAnimId of SOL_HEREDIT_RENDER_CONFIG.spotAnimIds ?? [])
      if (!effects.has(spotAnimId))
        effects.set(spotAnimId, { static: [], frames: [], frameLengths: [], frameStep: -1, heightOffset: 0 });
  }
  const engine = new SimulationEngine({ encounter: new SolHereditEncounter(7), combatSeed: 1 });
  const state = engine.getState();
  const context: RenderContext = {
    simulationState: state,
    events: [],
    interpolatedTick: 0,
    speedMultiplier: 1,
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
  };
  const draw = (tick: number, overrides: Partial<RenderContext> = {}) =>
    scene.build(
      {
        ...context,
        simulationState: { ...state, currentTick: Math.floor(tick) },
        interpolatedTick: tick,
        ...overrides,
      },
      projection,
      { width: 800, height: 600, dpr: 1 },
    );
  return { scene, manager, controller, draw, state, context, engine };
}

/** The fixture seeds only Sol; settle the other preloaded NPC types as failed loads so restorations can complete. */
function settleNpcTypes(scene: ColosseumSceneCompositor): void {
  for (const { npcTypeId } of SOL_HEREDIT_RENDER_CONFIG.preloadNpcTypes ?? []) {
    if (!scene.isNpcTypeLoaded(npcTypeId)) scene['failedNpcTypeLoadAttempts'].add(npcTypeId);
  }
}

function visual(overrides: Partial<EncounterVisualEvent> = {}): EncounterVisualEvent {
  return { type: 'encounter_visual', eventId: 1, tick: 0, animations: [], projectiles: [], graphics: [], ...overrides };
}

function recordSol(): ReplayRecorderData {
  const engine = new SimulationEngine({ encounter: new SolHereditEncounter(7), combatSeed: 1 });
  engine.setMechanicsConfig({ infiniteHealth: true });
  const recorder = new ReplayRecorder();
  recorder.startRun(engine.getRunConfig());
  recorder.recordPresentationState(1, 0, ReplayPresentationStateSchema.parse(validPresentationSample().state));
  for (let tick = 0; tick <= 16; tick++) {
    if (tick > 0) engine.advanceTick(engine.getState().playerPosition);
    const state = engine.getState();
    recorder.recordFrame(tick, state.playerPosition, state, engine.getLastTickEvents(), { recordedAtMs: tick * 600 });
  }
  return recorder.exportData();
}

describe('Colosseum presentation lifecycle', () => {
  it('does not leak already-indexed visible cues across a rewind or held-frame cutoff', () => {
    const source = recordSol();
    const { scene, controller, draw } = fixture();
    vi.spyOn(scene['spotAnimRenderer'], 'isLoaded').mockReturnValue(true);
    vi.spyOn(scene['spotAnimRenderer'], 'getFrameLengths').mockReturnValue([120]);
    const upsert = vi.spyOn(scene['spotAnimRenderer'], 'upsert');
    const seek = (tick: number, throughFrameIndex: number) =>
      draw(tick, {
        simulationState: source.frames[throughFrameIndex]!.state,
        replayHistory: { frames: source.frames, throughFrameIndex },
        timeline: { timelineKey: 'replay', paused: true },
      });
    seek(15.5, 15);
    expect(controller['primaryTrack']?.clip.id).toBe('shield');
    seek(9.5, 9);
    expect(controller['primaryTrack']?.clip.id).toBe('spear');
    expect(controller['primaryTrack']?.elapsedTicks).toBe(45);
    upsert.mockClear();
    seek(12.5, 9);
    expect(upsert).not.toHaveBeenCalled();
    seek(15.5, 9);
    expect(controller['primaryTrack']).toBeNull();
  });

  it('passes the snapshot tick separately from the replay presentation cycle to the NPC sampler', () => {
    const { scene, manager, state } = fixture();
    const sync = vi.spyOn(manager, 'syncInstances');
    scene['npcInterpFraction'] = 0.5;
    scene['primaryCycle'] = 3000;
    scene['syncNpcInstances'](state.npcs, false, { ...state, currentTick: 11 });
    expect(sync).toHaveBeenCalledWith(expect.any(Array), 0.5, 3000, 11);
  });

  it.each(['live', 'replay'])('follows the rendered Sol center, terrain and facing in %s', (mode) => {
    const { scene, manager, draw, state } = fixture();
    const terrain = Array.from({ length: 65 }, () => new Int32Array(65).fill(-256));
    scene['terrainHeights'] = terrain;
    manager.setTerrainHeights(terrain);
    vi.spyOn(scene['spotAnimRenderer'], 'isLoaded').mockReturnValue(true);
    vi.spyOn(scene['spotAnimRenderer'], 'getFrameLengths').mockReturnValue([120]);
    const upsert = vi.spyOn(scene['spotAnimRenderer'], 'upsert');
    const event: GameEvent = {
      type: 'encounter_visual',
      eventId: 1,
      tick: 0,
      animations: [],
      projectiles: [],
      graphics: [{ spotAnimId: 2668, target: { kind: 'attached', actorId: SOL_ACTOR_ID }, delayCycles: 0, height: 0 }],
    };
    const moving = {
      ...state,
      npcs: state.npcs.map((npc) => ({
        ...npc,
        previousPosition: [30, 30] satisfies [number, number],
        position: [32, 32] satisfies [number, number],
      })),
    };
    const frames = [{ state: moving, events: [event] }];

    draw(0.5, {
      simulationState: moving,
      events: [event],
      ...(mode === 'replay' ? { replayHistory: { frames, throughFrameIndex: 0 } } : {}),
    });

    const source = upsert.mock.lastCall?.[0].transform;
    const resolved = source?.kind === 'dynamic' ? source.resolve(0, 0.5, terrain) : null;
    const matrix = manager.getModelMatrix(PRIMARY_NPC_ACTOR_ID);
    expect(resolved?.position).toEqual([33.5, 33.5, 2]);
    expect(matrix).not.toBeNull();
    expect(resolved?.position).toEqual(matrix && [matrix[12], matrix[13], matrix[14]]);
    expect(resolved?.yaw2048).toBeCloseTo(matrix ? (Math.atan2(matrix[8], matrix[0]) * 2048) / (2 * Math.PI) : 0);
  });

  it('biases floor tile effects ahead of the terrain but leaves effects riding Sol unbiased', () => {
    const { scene, draw } = fixture();
    vi.spyOn(scene['spotAnimRenderer'], 'isLoaded').mockReturnValue(true);
    vi.spyOn(scene['spotAnimRenderer'], 'getFrameLengths').mockReturnValue([120]);
    const upsert = vi.spyOn(scene['spotAnimRenderer'], 'upsert');
    const event: GameEvent = {
      type: 'encounter_visual',
      eventId: 1,
      tick: 0,
      animations: [],
      projectiles: [],
      graphics: [
        { spotAnimId: 2668, target: { kind: 'attached', actorId: SOL_ACTOR_ID }, delayCycles: 0, height: 0 },
        {
          spotAnimId: COLOSSEUM_SPOTANIMS.solMelee[0],
          target: { kind: 'tile', position: [30, 30] },
          delayCycles: 0,
          height: 0,
        },
      ],
    };
    draw(0, { events: [event] });
    const styles = new Map(upsert.mock.calls.map(([request]) => [request.instanceId, request.style]));
    expect(styles.get('cue-1-graphic-0')).toBeUndefined();
    // Sol's melee puffs may also be left out of views that cannot see them (an iOS-only view).
    expect(styles.get('cue-1-graphic-1')).toEqual({ depthBias: FLOOR_EFFECT_DEPTH_BIAS, cullOutsideView: true });
  });

  it('opts Sol into the floor depth bias his shield slam needs', () => {
    const sol = SOL_HEREDIT_RENDER_CONFIG.preloadNpcTypes?.find((type) => type.npcTypeId === SOL_NPC_ID);
    expect(sol?.depthBias).toBe(FLOOR_EFFECT_DEPTH_BIAS);
  });

  it.each(['live', 'replay'] as const)('inherits shared model culling for tile and actor graphics in %s', (mode) => {
    const { scene, draw, state } = fixture();
    const renderer = scene['spotAnimRenderer'];
    const terrain = Array.from({ length: 65 }, () => new Int32Array(65).fill(-256));
    scene['terrainHeights'] = terrain;
    perfFlags.skipTransparentSort = true;
    const graphics = [
      COLOSSEUM_SPOTANIMS.crystalCharge[0],
      COLOSSEUM_SPOTANIMS.crystalFire[0],
      COLOSSEUM_SPOTANIMS.solMelee[0],
    ].map((spotAnimId) => ({
      spotAnimId,
      target: { kind: 'tile' as const, position: [30, 30] as [number, number] },
      delayCycles: 3,
      height: 128,
    }));
    const parts = new Map<number, ReturnType<typeof createSpotAnimMeshParts>>(
      graphics.map(({ spotAnimId }) => {
        const meshParts = createSpotAnimMeshParts(`graphic-style-${spotAnimId}`, {
          positions: new Float32Array([-32, 0, 0, 32, 0, 0, 0, 0, 32, -32, 0, 32, 32, 0, 32, 0, 0, 64]),
          hslColors: new Float32Array([9176, 9176, 9176, 8150, 8150, 8150]),
          alphas: new Float32Array([1, 1, 1, 0.5, 0.5, 0.5]),
          faceBias: new Float32Array(6),
          modelFaceIndices: new Uint32Array([0, 1]),
        });
        renderer['meshCache'].set(spotAnimId, {
          static: [],
          frames: [meshParts],
          frameLengths: [120],
          frameStep: -1,
          heightOffset: 99,
        });
        return [spotAnimId, meshParts] as const;
      }),
    );
    const attachedId = COLOSSEUM_SPOTANIMS.crystalCharge[0];
    const event = visual({
      graphics: [
        ...graphics,
        { spotAnimId: attachedId, target: { kind: 'attached', actorId: SOL_ACTOR_ID }, delayCycles: 3, height: 0 },
      ],
    });
    const upsert = vi.spyOn(renderer, 'upsert');
    const replay =
      mode === 'replay' ? { replayHistory: { frames: [{ state, events: [event] }], throughFrameIndex: 0 } } : {};

    draw(0, { events: [event], ...replay });
    expect(upsert).not.toHaveBeenCalled();
    const queue = draw(0.5, replay);

    const meshes = queue.commands.filter(
      (command): command is NpcMesh3DCommand =>
        command.kind === 'mesh3d' && command.meshId.startsWith('graphic-style-'),
    );
    expect(meshes).toHaveLength(event.graphics.length * 2);
    for (const [index, cue] of event.graphics.entries()) {
      const request = upsert.mock.calls.find(([value]) => value.instanceId === `cue-1-graphic-${index}`)?.[0];
      expect(request?.style).toEqual(
        cue.target.kind === 'attached'
          ? undefined
          : {
              depthBias: FLOOR_EFFECT_DEPTH_BIAS,
              ...((COLOSSEUM_SPOTANIMS.solMelee as readonly number[]).includes(cue.spotAnimId)
                ? { cullOutsideView: true }
                : {}),
            },
      );
      expect(request).toMatchObject({
        lifecycle: { kind: 'oneShot', startTick: 3 / 30, durationTicks: 120 / 30 },
        heightOffsetMode: 'actor',
      });
      if (cue.target.kind === 'tile') {
        expect(request?.transform.kind === 'dynamic' ? request.transform.resolve(0, 0.5, terrain) : null).toEqual({
          position: [30.5, 30.5, 3],
        });
      }
      const [opaque, alpha] = meshes.slice(index * 2, index * 2 + 2);
      expect([opaque.cullFace, alpha.cullFace]).toEqual(['back', 'back']);
      expect([opaque.depth, alpha.depth]).toEqual(['readwrite', 'read']);
      expect([opaque.blend, alpha.blend]).toEqual([undefined, 'normal']);
      expect([opaque.animated, alpha.animated]).toEqual([false, false]);
      for (const [partIndex, command] of [opaque, alpha].entries()) {
        const source = parts.get(cue.spotAnimId)?.[partIndex];
        expect(command.positions).toBe(source?.positions);
        expect(command.perVertexAlphas).toBe(source?.perVertexAlphas);
        expect(command.perVertexHslColors).toBe(source?.perVertexHslColors);
        expect(command.depthBias).toBe(cue.target.kind === 'attached' ? undefined : FLOOR_EFFECT_DEPTH_BIAS);
      }
    }
    expect(perfFlags.skipTransparentSort).toBe(true);
  });

  it('removes attached effects on despawn and accepts their IDs after reset', () => {
    const { scene, draw, state } = fixture();
    vi.spyOn(scene['spotAnimRenderer'], 'isLoaded').mockReturnValue(true);
    vi.spyOn(scene['spotAnimRenderer'], 'getFrameLengths').mockReturnValue([120]);
    const upsert = vi.spyOn(scene['spotAnimRenderer'], 'upsert');
    const despawn = vi.spyOn(scene['spotAnimRenderer'], 'despawn');
    const event: GameEvent = {
      type: 'encounter_visual',
      eventId: 1,
      tick: 0,
      animations: [],
      projectiles: [],
      graphics: [{ spotAnimId: 2668, target: { kind: 'attached', actorId: SOL_ACTOR_ID }, delayCycles: 0, height: 0 }],
    };
    draw(0, { events: [event] });
    expect(upsert).toHaveBeenCalled();
    upsert.mockClear();

    draw(0.5, {
      simulationState: { ...state, npcs: [] },
      events: [{ type: 'actor_despawned', eventId: 2, tick: 0, actorId: SOL_ACTOR_ID }],
    });

    expect(despawn).toHaveBeenCalledWith('cue-1-graphic-0');
    expect(upsert).not.toHaveBeenCalled();
    scene.resetIntroState();
    draw(0, { events: [event] });
    expect(upsert).toHaveBeenCalled();
  });

  it('hides attached replay effects for absent actors and restores them on rewind', () => {
    const { scene, draw, state } = fixture();
    vi.spyOn(scene['spotAnimRenderer'], 'isLoaded').mockReturnValue(true);
    vi.spyOn(scene['spotAnimRenderer'], 'getFrameLengths').mockReturnValue([120]);
    const upsert = vi.spyOn(scene['spotAnimRenderer'], 'upsert');
    const event = visual({
      graphics: [{ spotAnimId: 2668, target: { kind: 'attached', actorId: SOL_ACTOR_ID }, delayCycles: 0, height: 0 }],
    });
    const absent = { ...state, currentTick: 1, npcs: [] };
    const frames = [
      { state, events: [event] },
      { state: absent, events: [] },
    ];

    draw(1, { simulationState: absent, replayHistory: { frames, throughFrameIndex: 1 } });

    expect(upsert).not.toHaveBeenCalled();
    draw(0.5, { replayHistory: { frames, throughFrameIndex: 0 } });
    expect(upsert.mock.lastCall?.[0].spotAnimId).toBe(2668);
  });

  // A queued death reports alive: false from its killing tick but keeps that tick's swing (B:3356), and
  // stands until its death animation; an NPC already past it (or with no delay) plays nothing.
  it.each([
    { deathAnimationTick: 1, swings: true },
    { deathAnimationTick: undefined, swings: false },
  ])('plays a swing cued on the killing tick when the death animation is at $deathAnimationTick', ({
    deathAnimationTick,
    swings,
  }) => {
    const { controller, draw, state } = fixture();
    const killed = {
      ...state,
      npcs: state.npcs.map((npc) => ({
        ...npc,
        alive: false,
        hp: 0,
        despawnTick: 0,
        ...(deathAnimationTick === undefined ? {} : { deathAnimationTick }),
      })),
    };
    const swing = visual({ animations: [{ actorId: SOL_ACTOR_ID, clipId: 'spear', delayCycles: 0 }] });

    draw(0, { simulationState: killed, events: [swing] });
    draw(0.5, { simulationState: killed });

    expect(controller['primaryTrack']?.clip.id === 'spear').toBe(swings);
  });

  it('applies multiple due cues chronologically with fractional phase', () => {
    const { controller, draw } = fixture();
    draw(0, {
      events: [
        visual({
          animations: [
            { actorId: SOL_ACTOR_ID, clipId: 'spear', delayCycles: 2 },
            { actorId: SOL_ACTOR_ID, clipId: 'shield', delayCycles: 8 },
          ],
        }),
      ],
    });
    draw(10.5 / 30);
    expect(controller['primaryTrack']?.clip.id).toBe('shield');
    expect(controller['primaryTrack']?.elapsedTicks).toBe(2);
    expect(controller['tickRemainderMs']).toBeCloseTo(10);
  });

  it('uses only displayed elapsed time regardless of wall time, rate, or held frame', () => {
    const { scene, controller, draw } = fixture();
    draw(0, { events: [visual({ animations: [{ actorId: SOL_ACTOR_ID, clipId: 'spear', delayCycles: 0 }] })] });
    scene['lastNpcVisualUpdateTime'] = performance.now() - 100;
    draw(0.5, { speedMultiplier: 3 });
    draw(0.5, { timeline: { timelineKey: 'live', paused: true } });
    expect(controller['primaryTrack']?.elapsedTicks).toBe(15);
  });

  it('advances Sol exactly once when restored history hands off 150 ms after GO', () => {
    const { scene, engine, manager, controller, draw, state } = fixture();
    settleNpcTypes(scene);
    vi.spyOn(scene['spotAnimRenderer'], 'isLoaded').mockReturnValue(true);
    const event = visual({ animations: [{ actorId: SOL_ACTOR_ID, clipId: 'spear', delayCycles: 0 }] });
    const restoration: RestoredPresentation = {
      engine,
      tick: 0,
      timeMs: 600,
      history: { frames: [{ state, events: [event] }], throughFrameIndex: 0 },
    };
    for (let frame = 0; frame < 3; frame++)
      draw(1, {
        simulationState: state,
        events: [event],
        restoredPresentation: restoration,
        frameDeltaMs: 0,
        timeline: { timelineKey: 'restored-sol', paused: true, timeMs: 600 },
      });
    expect(controller['primaryTrack']?.elapsedTicks).toBe(30);
    const advance = vi.spyOn(manager, 'updateAnimations');
    draw(1.25, {
      events: [],
      restoredPresentation: restoration,
      frameDeltaMs: 150,
      timeline: { timelineKey: 'restored-sol', paused: false, timeMs: 750 },
    });
    expect(scene['replayEffectIndex']).toBeUndefined();
    expect(advance.mock.calls.reduce((total, [delta, speed]) => total + delta * speed, 0)).toBeCloseTo(150);
    expect(controller['primaryTrack']?.elapsedTicks).toBe(37);
    expect(controller['tickRemainderMs']).toBeCloseTo(10);
    expect(controller['primaryTrack']?.clip.id).toBe('spear');
  });

  it('starts a delayed grapple after restored history first initializes partway through a newer live tick', () => {
    const tick = 1;
    const live = fixture();
    const restored = fixture();
    settleNpcTypes(restored.scene);
    vi.spyOn(restored.scene['spotAnimRenderer'], 'isLoaded').mockReturnValue(true);
    // Sol's production grapple cue: emitted on tick T+1, its telegraph starts one tick later.
    const grapple = visual({
      eventId: 5,
      tick: tick + 1,
      animations: [{ actorId: SOL_ACTOR_ID, clipId: 'grapple', delayCycles: 30 }],
    });
    const frames: ReplayDisplayFrame[] = [0, 1, 2].map((currentTick) => ({
      state: { ...live.state, currentTick },
      events: currentTick === tick + 1 ? [grapple] : [],
    }));
    // Completed tick T is restored, but the first render (or asset settle) lands during T+1.
    const restoration: RestoredPresentation = {
      engine: restored.engine,
      tick,
      timeMs: (tick + 1) * 600,
      history: { frames, throughFrameIndex: tick },
    };
    const restoredDraw = (at: number, events: GameEvent[]) =>
      restored.draw(at, {
        events,
        restoredPresentation: restoration,
        frameDeltaMs: 150,
        timeline: { timelineKey: 'restored-sol', paused: false, timeMs: at * 600 },
      });
    restoredDraw(tick + 1.25, [grapple]);
    expect(restored.scene['replayEffectIndex']).toBeDefined();
    restoredDraw(tick + 1.5, [grapple]);
    expect(restored.scene['replayEffectIndex']).toBeUndefined();
    live.draw(tick + 1, { events: [grapple] });
    live.draw(tick + 1.25, { events: [grapple] });
    live.draw(tick + 1.5, { events: [grapple] });
    for (const at of [tick + 2, tick + 2.25, tick + 2.5]) {
      live.draw(at);
      restoredDraw(at, []);
      expect(live.controller['primaryTrack']?.clip.id).toBe('grapple');
      expect(restored.controller['primaryTrack']?.clip.id).toBe('grapple');
      expect(restored.controller['primaryTrack']?.elapsedTicks).toBe(live.controller['primaryTrack']?.elapsedTicks);
      expect(restored.controller['tickRemainderMs']).toBeCloseTo(live.controller['tickRemainderMs']);
    }
  });

  it.each([
    'live',
    'replay',
  ])('bounds catch-up work when %s presentation time runs far past a held snapshot', (mode) => {
    const { scene, manager, controller, draw, state } = fixture();
    const event = visual({ animations: [{ actorId: SOL_ACTOR_ID, clipId: 'spear', delayCycles: 0 }] });
    const replay =
      mode === 'replay'
        ? {
            replayHistory: { frames: [{ state, events: [event] }], throughFrameIndex: 0 },
            timeline: { timelineKey: 'replay', paused: false },
          }
        : {};
    draw(0.5, { events: [event], ...replay });
    expect(controller['primaryTrack']?.clip.id).toBe('spear');
    const update = vi.spyOn(manager, 'updateAnimations');

    // A one-frame recording whose cursor sits ~1e12 ms out holds tick 0 the whole way.
    const timeMs = 6e11;
    draw(timeMs / 600, {
      simulationState: state,
      ...replay,
      ...(mode === 'replay' ? { timeline: { timelineKey: 'replay', paused: false, timeMs } } : {}),
    });

    expect(scene['lastDiscontinuityReason']).toBeNull();
    expect(update.mock.calls.length).toBeLessThanOrEqual(100);
    expect(scene['npcAnimationCycle']).toBe(timeMs / 20);
    expect(controller['primaryTrack']).toBeNull();
    expect(controller['tickRemainderMs']).toBeLessThan(20);
    expect(Number.isFinite(controller['baseTrack']?.elapsedTicks)).toBe(true);
  });

  // Facing and clips share one NPC clock: the displayed cycle. A held snapshot's tick plus its clamped
  // interpolation would stop turning one tick past the snapshot while the clips run on.
  it.each([
    'live',
    'replay',
  ])('turns Sol by exactly the cycles the NPC clock advances in %s, past a held snapshot too', (mode) => {
    const { scene, manager, draw, state } = fixture();
    const frames = [{ state, events: [] }];
    const replay = (timeMs: number) =>
      mode === 'replay'
        ? {
            replayHistory: { frames, throughFrameIndex: 0 },
            timeline: { timelineKey: 'replay', paused: false, timeMs },
          }
        : {};
    draw(0.5, { simulationState: state, ...replay(300) });
    const start = scene['npcAnimationCycle'];
    expect(start).toBe(15);
    const facing = vi.spyOn(manager, 'updateNpcVisualFacing');
    for (const timeMs of [600, 900, 1200, 1500]) draw(timeMs / 600, { simulationState: state, ...replay(timeMs) });

    expect(scene['npcAnimationCycle']).toBe(75);
    const turnedMs = facing.mock.calls.reduce((total, [, deltaMs]) => total + deltaMs, 0);
    expect(turnedMs).toBe((75 - 15) * 20);
  });

  it('accepts reused event IDs after reset instead of retaining the old cue', () => {
    const { scene, controller, draw } = fixture();
    draw(0, { events: [visual({ animations: [{ actorId: SOL_ACTOR_ID, clipId: 'spear', delayCycles: 20 }] })] });
    scene.resetIntroState();
    draw(0, { events: [visual({ animations: [{ actorId: SOL_ACTOR_ID, clipId: 'shield', delayCycles: 0 }] })] });
    draw(0.8);
    expect(controller['primaryTrack']?.clip.id).toBe('shield');
  });

  it.each([0, 128])('places graphics at world height with height offset %s and removes expired instances', (height) => {
    const { scene, draw } = fixture();
    scene['terrainHeights'] = Array.from({ length: 65 }, () => new Int32Array(65).fill(-256));
    vi.spyOn(scene['spotAnimRenderer'], 'isLoaded').mockReturnValue(true);
    vi.spyOn(scene['spotAnimRenderer'], 'getFrameLengths').mockReturnValue([30]);
    const upsert = vi.spyOn(scene['spotAnimRenderer'], 'upsert');
    const despawn = vi.spyOn(scene['spotAnimRenderer'], 'despawn');
    draw(0, {
      events: [
        visual({ graphics: [{ spotAnimId: 1, target: { kind: 'tile', position: [30, 30] }, delayCycles: 0, height }] }),
      ],
    });
    const transform = upsert.mock.calls[0]?.[0].transform;
    expect(transform?.kind === 'dynamic' ? transform.resolve(0, 0, null)?.position : undefined).toEqual([
      30.5,
      30.5,
      2 + height / 128,
    ]);
    draw(1);
    expect(despawn).toHaveBeenCalledWith('cue-1-graphic-0');
  });

  it.each([0.5, 2, 0.25])('restores a mid-telegraph pose at replay tick %s', (tick) => {
    const { scene, controller, draw, state } = fixture();
    const event = visual({ animations: [{ actorId: SOL_ACTOR_ID, clipId: 'shield', delayCycles: 3 }] });
    const frames: ReplayDisplayFrame[] = [0, 1, 2].map((currentTick) => ({
      state: { ...state, currentTick },
      events: currentTick === 0 ? [event] : [],
    }));
    vi.spyOn(scene['spotAnimRenderer'], 'isLoaded').mockReturnValue(true);
    draw(tick, {
      replayHistory: { frames, throughFrameIndex: Math.floor(tick) },
      timeline: { timelineKey: 'replay', paused: true },
    });
    expect(controller['primaryTrack']?.clip.id).toBe('shield');
    expect(controller['primaryTrack']?.elapsedTicks).toBe(Math.floor(tick * 30 - 3));
  });

  it('removes actor presentation when the actor despawns', () => {
    const { manager, draw } = fixture();
    const remove = vi.spyOn(manager, 'removePresentation');
    const events: GameEvent[] = [{ type: 'actor_despawned', eventId: 2, tick: 0, actorId: 'crystal' }];
    draw(0, { events });
    expect(remove).toHaveBeenCalledWith('crystal');
  });

  it.each([
    false,
    true,
  ])('reconstructs graphics across rewind, forward seek, and same-tick history replacement (attached=%s)', (attached) => {
    const { scene, draw, state } = fixture();
    vi.spyOn(scene['spotAnimRenderer'], 'isLoaded').mockReturnValue(true);
    vi.spyOn(scene['spotAnimRenderer'], 'getFrameLengths').mockReturnValue([60]);
    const upsert = vi.spyOn(scene['spotAnimRenderer'], 'upsert');
    const despawn = vi.spyOn(scene['spotAnimRenderer'], 'despawn');
    const event = visual({
      graphics: [
        attached
          ? { spotAnimId: 2668, target: { kind: 'attached', actorId: SOL_ACTOR_ID }, delayCycles: 6, height: 0 }
          : { spotAnimId: 1, target: { kind: 'tile', position: [30, 30] }, delayCycles: 6, height: 0 },
      ],
    });
    const frames: ReplayDisplayFrame[] = [0, 1, 2, 3].map((currentTick) => ({
      state: { ...state, currentTick },
      events: currentTick === 0 ? [event] : [],
    }));
    const seek = (tick: number) =>
      draw(tick, {
        replayHistory: { frames, throughFrameIndex: Math.floor(tick) },
        timeline: { timelineKey: 'replay', paused: true },
      });
    seek(1);
    expect(upsert.mock.lastCall?.[0].lifecycle).toEqual({ kind: 'oneShot', startTick: 0.2, durationTicks: 2 });
    seek(3);
    expect(despawn).toHaveBeenCalledWith('cue-1-graphic-0');
    upsert.mockClear();
    seek(0.5);
    expect(upsert).toHaveBeenCalled();
    upsert.mockClear();
    draw(0.5, {
      replayHistory: { frames: [{ state, events: [] }], throughFrameIndex: 0 },
      timeline: { timelineKey: 'replay', paused: true },
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each(['live', 'takeover'])('clears replay cues on %s entry and accepts reused IDs', (timelineKey) => {
    const { controller, draw, state } = fixture();
    const frames = [
      { state, events: [visual({ animations: [{ actorId: SOL_ACTOR_ID, clipId: 'spear', delayCycles: 0 }] })] },
    ];
    draw(0.5, { replayHistory: { frames, throughFrameIndex: 0 }, timeline: { timelineKey: 'replay', paused: true } });
    draw(0.5, {
      timeline: { timelineKey, paused: false },
      events: [visual({ animations: [{ actorId: SOL_ACTOR_ID, clipId: 'shield', delayCycles: 0 }] })],
    });
    expect(controller['primaryTrack']?.clip.id).toBe('shield');
  });

  it('retries unavailable graphic metadata on a held replay frame without changing its origin', () => {
    const { scene, draw, state } = fixture();
    const loaded = vi.spyOn(scene['spotAnimRenderer'], 'isLoaded').mockReturnValue(false);
    const lengths = vi.spyOn(scene['spotAnimRenderer'], 'getFrameLengths').mockReturnValue(undefined);
    const upsert = vi.spyOn(scene['spotAnimRenderer'], 'upsert');
    const replayHistory = {
      frames: [
        {
          state,
          events: [
            visual({
              graphics: [{ spotAnimId: 1, target: { kind: 'tile', position: [30, 30] }, delayCycles: 3, height: 0 }],
            }),
          ],
        },
      ],
      throughFrameIndex: 0,
    };
    draw(0.5, { replayHistory });
    expect(upsert).not.toHaveBeenCalled();
    loaded.mockReturnValue(true);
    lengths.mockReturnValue([60]);
    draw(0.5, { replayHistory });
    expect(upsert.mock.lastCall?.[0].lifecycle).toEqual({ kind: 'oneShot', startTick: 0.1, durationTicks: 2 });
  });

  it('wires frame sounds and silently synchronizes them during seeks and pauses', () => {
    const engine = new AudioEngine();
    const tracker = new FrameSoundTracker(engine);
    const scene = createSolHereditSceneBuilder({ frameSoundTracker: tracker });
    if (!(scene instanceof ColosseumSceneCompositor)) throw new Error('wrong scene builder');
    scenes.push(scene);
    const update = vi.spyOn(tracker, 'update');
    const silent = vi.spyOn(tracker, 'silentSync');
    const reset = vi.spyOn(tracker, 'reset');
    const { context: input } = fixture();
    scene.build(input, projection, { width: 800, height: 600, dpr: 1 });
    expect(update).toHaveBeenCalledOnce();
    scene.build({ ...input, timeline: { timelineKey: 'replay', paused: true } }, projection, {
      width: 800,
      height: 600,
      dpr: 1,
    });
    expect(silent).toHaveBeenCalledOnce();
    scene.resetIntroState();
    expect(reset).toHaveBeenCalled();
    engine.dispose();
  });

  it('restores the same pose through continuous replay, forward seeks, and fractional rewinds', () => {
    const { controller, draw, state } = fixture();
    const frames: ReplayDisplayFrame[] = Array.from({ length: 7 }, (_, currentTick) => ({
      state: { ...state, currentTick },
      events:
        currentTick === 0
          ? [
              visual({
                animations: [
                  { actorId: SOL_ACTOR_ID, clipId: 'spear', delayCycles: 2 },
                  { actorId: SOL_ACTOR_ID, clipId: 'shield', delayCycles: 8 },
                ],
              }),
            ]
          : [],
    }));
    const seek = (tick: number) =>
      draw(tick, {
        replayHistory: { frames, throughFrameIndex: Math.floor(tick) },
        timeline: { timelineKey: 'replay', paused: true },
      });
    seek(0);
    seek(0.5);
    expect(controller['primaryTrack']?.elapsedTicks).toBe(7);
    seek(3);
    expect(controller['primaryTrack']?.elapsedTicks).toBe(82);
    seek(3.5);
    seek(3.25);
    expect(controller['primaryTrack']?.elapsedTicks).toBe(89);
    seek(6);
    expect(controller['primaryTrack']).toBeNull();
    seek(0.5);
    expect(controller['primaryTrack']?.clip.id).toBe('shield');
    expect(controller['primaryTrack']?.elapsedTicks).toBe(7);
  });

  it.each([
    'continuous',
    'seek',
  ] as const)('restores a warbander’s kill-tick swing and delayed death across %s replay and rewind', (mode) => {
    const { manager, controller, draw, state } = fixture();
    const actorId = 'warbander';
    seed(manager, {
      actorId,
      npcTypeId: WARBAND_BERSERKER_NPC_ID,
      position: [30, 30],
      size: 1,
      facing: 0,
      rotationSpeed: 32,
    });
    const animationSet: NpcAnimationSet = {
      idle: clip('idle', 1),
      attackClips: { attack: clip('attack', 2) },
      death: clip('death', 4),
    };
    const makeController = () => new NpcAnimationController({ animationSet, modelAdapter: controller['modelAdapter'] });
    const instance = manager['instanceRegistry'].get(actorId);
    const type = manager['typeRegistry'].get(WARBAND_BERSERKER_NPC_ID);
    if (!instance || !type) throw new Error('missing seeded warbander');
    instance.animController = makeController();
    type.animationSet = animationSet;
    // The fixture has no cache models. Keep recreated instances animation-ready on a rewind,
    // without replacing the manager’s actual standing/death or timeline-restoration behavior.
    const createInstance = manager['createInstance'].bind(manager);
    manager['createInstance'] = (...args) => {
      const restored = createInstance(...args);
      if (restored.actorId === actorId) restored.animController = makeController();
      return restored;
    };
    const template = state.npcs[0];
    if (!template) throw new Error('missing snapshot template');
    const swing = visual({
      tick: 1,
      animations: [{ actorId, clipId: 'attack', delayCycles: 0 }],
    });
    const frames: ReplayDisplayFrame[] = Array.from({ length: 6 }, (_, currentTick) => ({
      state: {
        ...state,
        currentTick,
        npcs: [
          {
            ...template,
            id: actorId,
            npcTypeId: WARBAND_BERSERKER_NPC_ID,
            role: 'minion',
            size: 1,
            spawnTick: 0,
            alive: currentTick === 0,
            hp: currentTick === 0 ? 48 : 0,
            maxHp: 48,
            previousPosition: currentTick <= 1 ? [30, 30] : [31, 30],
            position: currentTick === 0 ? [30, 30] : [31, 30],
            ...(currentTick === 0 ? {} : { despawnTick: 1, deathAnimationTick: 4 }),
          },
        ],
      },
      events: currentTick === 1 ? [swing] : [],
    }));
    const display = (tick: number) => {
      draw(tick, {
        simulationState: frames[Math.floor(tick)]!.state,
        replayHistory: { frames, throughFrameIndex: Math.floor(tick) },
        timeline: { timelineKey: 'replay', paused: mode === 'seek' },
      });
    };
    const expectStanding = (tick: number) => {
      expect(manager.getDyingActorIds()).toEqual(new Set());
      const active = manager['instanceRegistry'].get(actorId)?.animController;
      expect(active?.getActiveState()).toBe('attack');
      expect(active?.getFrameState()?.seqId).toBe(2);
      expect(active?.['primaryTrack']?.elapsedTicks).toBe((tick - 1) * 30);
      expect(manager.getVisualPosition(actorId)).toEqual(tick === 1.5 ? [30.5, 30] : [31, 30]);
    };
    const expectDeath = (tick: number) => {
      expect(manager.getDyingActorIds()).toEqual(new Set([actorId]));
      const dying = manager['dyingInstances'].get(actorId);
      expect(dying?.deathTimerMs).toBe((tick - 4) * 600);
      expect(dying?.instance.animController?.getActiveState()).toBe('death');
      expect(dying?.instance.animController?.getFrameState()?.seqId).toBe(4);
      expect(dying?.instance.animController?.['primaryTrack']?.elapsedTicks).toBe((tick - 4) * 30);
    };

    if (mode === 'continuous') {
      for (let tick = 0; tick <= 4.5; tick += 0.5) {
        display(tick);
        if (tick === 1.5 || tick === 3.5) expectStanding(tick);
        if (tick === 4 || tick === 4.5) expectDeath(tick);
      }
    } else {
      display(1.5);
      expectStanding(1.5);
      display(4.5);
      expectDeath(4.5);
    }
    display(1.5);
    expectStanding(1.5);
    display(4);
    expectDeath(4);
    display(3.5);
    expectStanding(3.5);
  });

  it('reconstructs a dead actor at fractional death age rather than restarting it', () => {
    const { scene, manager, draw, state } = fixture();
    const type = manager['typeRegistry'].get(SOL_NPC_ID);
    if (!type?.animationSet) throw new Error('missing animation set');
    type.animationSet.death = clip('death', 4);
    type.bossDeathAnimationEnabled = true;
    const dead = {
      ...state,
      currentTick: 2,
      npcs: state.npcs.map((npc) => ({ ...npc, alive: false, hp: 0, despawnTick: 1 })),
    };
    const restore = vi.spyOn(manager, 'reconstructDyingInstance');
    draw(2.5, {
      simulationState: dead,
      replayHistory: { frames: [{ state: dead, events: [] }], throughFrameIndex: 0 },
    });
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ id: PRIMARY_NPC_ACTOR_ID }), 900);
    expect(scene['npcInstanceManager']['dyingInstances'].size).toBe(1);
  });
});

describe('Colosseum projectiles', () => {
  // The seer's captured cast: WARBAND_PROJECTILES.seer and its impact on the player.
  const cast = visual({
    projectiles: [
      {
        spotAnimId: COLOSSEUM_SPOTANIMS.warbandFireblast,
        sourcePosition: [20.5, 21.5],
        target: { kind: 'actor', actorId: 'player', size: 1, position: [20, 20] },
        startDelayCycles: 10,
        endDelayCycles: 30,
        slope: 16,
        startOffset: 64,
        startHeight: 172,
        endHeight: 124,
      },
    ],
    graphics: [
      {
        spotAnimId: COLOSSEUM_SPOTANIMS.fireblastImpact,
        target: { kind: 'attached', actorId: 'player' },
        delayCycles: 30,
        height: 124,
      },
    ],
  });
  const PROJECTILE = 'cue-1-projectile-0';

  function scene(assets: 'settled' | 'pending' = 'settled') {
    const setup = fixture(undefined, assets);
    const terrain = Array.from({ length: 65 }, () => new Int32Array(65).fill(-256));
    setup.scene['terrainHeights'] = terrain;
    vi.spyOn(setup.scene['spotAnimRenderer'], 'isLoaded').mockReturnValue(true);
    vi.spyOn(setup.scene['spotAnimRenderer'], 'getFrameLengths').mockReturnValue([30]);
    vi.spyOn(setup.scene['spotAnimRenderer'], 'getFrameStep').mockReturnValue(-1);
    const upsert = vi.spyOn(setup.scene['spotAnimRenderer'], 'upsert');
    const despawn = vi.spyOn(setup.scene['spotAnimRenderer'], 'despawn');
    const still = {
      ...setup.state,
      playerPosition: [20, 20] satisfies [number, number],
      playerPreviousPosition: [20, 20] satisfies [number, number],
      playerMovementPath: [],
    };
    const position = (instanceId: string) => {
      const transform = upsert.mock.calls
        .filter(([request]) => request.instanceId === instanceId)
        .at(-1)?.[0].transform;
      if (transform?.kind === 'static') return transform.value.position;
      return transform?.resolve(0, 0, terrain)?.position;
    };
    return { ...setup, upsert, despawn, still, position };
  }

  it('flies the cast from the seer to the player, then plays the impact on arrival', () => {
    const { draw, upsert, despawn, still, position } = scene();

    draw(0, { simulationState: still, events: [cast] });
    expect(upsert.mock.calls.some(([request]) => request.instanceId === PROJECTILE)).toBe(false);
    draw(0.5, { simulationState: still });
    const [x, y, z] = position(PROJECTILE) ?? [];
    expect(x).toBeCloseTo(20.5);
    expect(y).toBeGreaterThan(20.5);
    expect(y).toBeLessThan(21.5);
    expect(z).toBeGreaterThan(2 + 124 / 128);
    upsert.mockClear();

    draw(1, { simulationState: { ...still, currentTick: 1 } });

    expect(despawn).toHaveBeenCalledWith(PROJECTILE);
    expect(upsert.mock.calls.some(([request]) => request.instanceId === PROJECTILE)).toBe(false);
    expect(upsert.mock.lastCall?.[0].spotAnimId).toBe(COLOSSEUM_SPOTANIMS.fireblastImpact);
    expect(position('cue-1-graphic-0')).toEqual([20.5, 20.5, 2 + 124 / 128]);
  });

  it('reconstructs the same flight on replay seeks and drops it once landed', () => {
    const live = scene();
    live.draw(0, { simulationState: live.still, events: [cast] });
    live.draw(0.5, { simulationState: live.still });
    const { draw, upsert, despawn, still, position } = scene();
    const frames: ReplayDisplayFrame[] = [0, 1, 2].map((currentTick) => ({
      state: { ...still, currentTick },
      events: currentTick === 0 ? [cast] : [],
    }));
    const seek = (tick: number) =>
      draw(tick, {
        simulationState: frames[Math.floor(tick)]!.state,
        replayHistory: { frames, throughFrameIndex: Math.floor(tick) },
        timeline: { timelineKey: 'replay', paused: true },
      });
    const expectLivePosition = () => {
      const expected = live.position(PROJECTILE) ?? [];
      const actual = position(PROJECTILE) ?? [];
      expect(actual).toHaveLength(3);
      for (const [axis, value] of expected.entries()) expect(actual[axis]).toBeCloseTo(value, 9);
    };

    seek(0.5);
    expectLivePosition();
    seek(1.5);
    expect(despawn).toHaveBeenCalledWith(PROJECTILE);
    upsert.mockClear();
    seek(1.5);
    expect(upsert.mock.calls.some(([request]) => request.instanceId === PROJECTILE)).toBe(false);
    seek(0.5);
    expectLivePosition();
  });

  it('re-flies a restored totem flight toward a moving target from history, matching replay', () => {
    const heal = visual({
      eventId: 10,
      projectiles: [
        {
          ...HEALING_TOTEM_PROJECTILE,
          sourcePosition: [20.5, 30.5],
          target: { kind: 'actor', actorId: 'player', size: 1, position: [20, 20] },
        },
      ],
    });
    const id = 'cue-10-projectile-0';
    const replay = scene();
    const restored = scene();
    // The player runs east two tiles a tick from tick 3, while the six-tick flight is airborne.
    const frames: ReplayDisplayFrame[] = [0, 1, 2, 3, 4].map((currentTick) => {
      const from = currentTick < 3 ? 20 : 20 + (currentTick - 3) * 2;
      const to = currentTick < 3 ? 20 : from + 2;
      return {
        state: {
          ...replay.still,
          currentTick,
          playerPreviousPosition: [from, 20],
          playerMovementPath:
            currentTick < 3
              ? []
              : [
                  [from + 1, 20],
                  [to, 20],
                ],
          playerPosition: [to, 20],
        },
        events: currentTick === 0 ? [heal] : [],
      };
    });
    const timeMs = 5 * 600;
    replay.draw(5, {
      simulationState: frames[4]!.state,
      replayHistory: { frames, throughFrameIndex: 4 },
      timeline: { timelineKey: 'replay', paused: true, timeMs },
    });
    const restoration: RestoredPresentation = {
      engine: restored.engine,
      tick: 4,
      timeMs,
      history: { frames, throughFrameIndex: 4 },
    };
    restored.draw(5, {
      simulationState: frames[4]!.state,
      events: [],
      restoredPresentation: restoration,
      frameDeltaMs: 0,
      timeline: { timelineKey: 'restored-sol', paused: true, timeMs },
    });
    const expected = replay.position(id) ?? [];
    const actual = restored.position(id) ?? [];
    expect(expected).toHaveLength(3);
    expect(actual).toHaveLength(3);
    for (const [axis, value] of expected.entries()) expect(actual[axis]).toBeCloseTo(value, 9);
  });

  it('keeps a restored beam’s future segments and impact through the restored-to-live handoff', () => {
    const tick = 2;
    const base = tick * 30;
    const tiles: Coordinate[] = Array.from({ length: 13 }, (_, index) => [30, 20 + index]);
    const beam = visual({ eventId: 7, tick, graphics: colosseumBeamGraphics('north', tiles, 'fire') });
    const impact = `cue-7-graphic-${tiles.length}`;
    const live = scene();
    const restored = scene();
    settleNpcTypes(restored.scene);
    const drawn = (setup: ReturnType<typeof scene>, draw: () => void) => {
      setup.upsert.mockClear();
      draw();
      return setup.upsert.mock.calls.map(([request]) => request.instanceId).sort();
    };
    const frames: ReplayDisplayFrame[] = [0, 1, 2].map((currentTick) => ({
      state: { ...live.state, currentTick },
      events: currentTick === tick ? [beam] : [],
    }));
    const restoration: RestoredPresentation = {
      engine: restored.engine,
      tick,
      timeMs: (base + 30) * 20,
      history: { frames, throughFrameIndex: tick },
    };
    live.draw(tick, { events: [beam] });
    const liveAtBoundary = drawn(live, () => live.draw(tick + 1, { simulationState: frames[tick]!.state }));
    for (let frame = 0; frame < 3; frame++) {
      const held = drawn(restored, () =>
        restored.draw(tick + 1, {
          simulationState: frames[tick]!.state,
          events: [beam],
          restoredPresentation: restoration,
          frameDeltaMs: 0,
          timeline: { timelineKey: 'restored-sol', paused: true, timeMs: restoration.timeMs },
        }),
      );
      expect(held).toEqual(liveAtBoundary);
    }
    frames.push({ state: { ...live.state, currentTick: tick + 1 }, events: [] });
    let sawImpact = false;
    for (let cycle = base + 31; cycle <= base + 75; cycle++) {
      const expected = drawn(live, () => live.draw(cycle / 30));
      const actual = drawn(restored, () =>
        restored.draw(cycle / 30, {
          events: [],
          restoredPresentation: restoration,
          frameDeltaMs: 20,
          timeline: { timelineKey: 'restored-sol', paused: false, timeMs: cycle * 20 },
        }),
      );
      // Live play owns the cues from the first frame after GO; no replay targeting is retained.
      expect(restored.scene['replayEffectIndex']).toBeUndefined();
      expect(actual, `cycle ${cycle}`).toEqual(expected);
      sawImpact ||= actual.includes(impact);
    }
    expect(sawImpact).toBe(true);
  });

  it('keeps restored history past GO until Colosseum NPC types settle, then hands off', () => {
    const { scene: compositor, draw, state, engine } = scene('pending');
    const restoration: RestoredPresentation = {
      engine,
      tick: 0,
      timeMs: 600,
      history: { frames: [{ state, events: [cast] }], throughFrameIndex: 0 },
    };
    const restoredDraw = (tick: number, paused: boolean) =>
      draw(tick, {
        events: [],
        restoredPresentation: restoration,
        frameDeltaMs: paused ? 0 : 20,
        timeline: { timelineKey: 'restored-sol', paused, timeMs: tick * 600 },
      });
    restoredDraw(1, true);
    restoredDraw(31 / 30, false);
    expect(compositor['replayEffectIndex']).toBeDefined();
    settleNpcTypes(compositor);
    restoredDraw(32 / 30, false);
    expect(compositor['replayEffectIndex']).toBeDefined();
    restoredDraw(33 / 30, false);
    expect(compositor['replayEffectIndex']).toBeUndefined();
  });
});

describe('Sol beam damage debug overlay', () => {
  function overlay(debugFlags: Record<string, boolean>, is2D: boolean) {
    const { scene, state } = fixture();
    if (state.encounter.kind !== 'sol_heredit') throw new Error('wrong snapshot');
    const fired: [number, number][] = [
      [30, 41],
      [31, 41],
    ];
    const simulationState = {
      ...state,
      mechanicsConfig: { ...state.mechanicsConfig, solHereditTelegraph: false },
      encounter: { ...state.encounter, state: { ...state.encounter.state, beamFiredTiles: fired } },
    };
    scene['terrainHeights'] = scene['terrainHeights'] ?? ({} as never);
    const meshes = vi
      .spyOn(scene as never as { pushTileMesh3D: () => void }, 'pushTileMesh3D')
      .mockImplementation(() => {});
    const queue = { replayPresentationReady: true, commands: [] };
    scene['renderEncounterDebugOverlays'](queue, projection, simulationState, 0, is2D, debugFlags);
    return { commands: queue.commands, meshes: meshes.mock.calls.map((call: unknown[]) => call.slice(1, 3)) };
  }

  it('paints the fired tiles in 2D only with the flag on, regardless of the telegraph aid', () => {
    expect(overlay({}, true).commands).toEqual([]);
    expect(overlay({ beamDamageTiles: true }, true).commands).toEqual([
      expect.objectContaining({
        kind: 'poly2d',
        points: [
          [30, 41],
          [31, 41],
          [31, 42],
          [30, 42],
        ].map(([x, y]) => ({ x, y, level: 0 })),
      }),
      expect.objectContaining({ kind: 'poly2d' }),
    ]);
  });

  it('paints the fired tiles as 3D tile meshes only with the flag on', () => {
    expect(overlay({}, false).meshes).toEqual([]);
    expect(overlay({ beamDamageTiles: true }, false).meshes).toEqual([
      [30, 41],
      [31, 41],
    ]);
  });
});

describe('Sol melee view rejection', () => {
  const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const camera = { ...projection, viewMatrix: identity, projectionMatrix: identity };

  /** Every `setViewRejection` argument, and whether a view was set while the spot-animation renderer drew. */
  function observe(scene: ColosseumSceneCompositor) {
    const renderer = scene['spotAnimRenderer'];
    const set = vi.spyOn(renderer, 'setViewRejection');
    const render = renderer.render.bind(renderer);
    const viewWhileDrawing: boolean[] = [];
    vi.spyOn(renderer, 'render').mockImplementation((queue) => {
      viewWhileDrawing.push(renderer['hasViewRejection']);
      render(queue);
    });
    return { set, viewWhileDrawing, hasView: () => renderer['hasViewRejection'] };
  }

  it('hands the renderer this frame’s camera for the build only, when enabled in 3D', () => {
    const { scene, context } = fixture({ cullSolMeleeOutsideView: true });
    const { set, viewWhileDrawing, hasView } = observe(scene);
    scene.build(context, camera, { width: 800, height: 600, dpr: 1 });
    expect(set.mock.calls).toEqual([[camera], [null]]);
    expect(viewWhileDrawing).toEqual([true]);
    expect(hasView()).toBe(false);
  });

  it.each([
    ['disabled', false, '3d', true],
    ['2D', true, '2d', true],
    ['not given a camera', true, '3d', false],
  ] as const)('sets no view when %s', (_, enabled, renderMode, withCamera) => {
    const { scene, context } = fixture({ cullSolMeleeOutsideView: enabled });
    const { set, viewWhileDrawing } = observe(scene);
    scene.build({ ...context, options: { ...context.options, renderMode } }, withCamera ? camera : projection, {
      width: 800,
      height: 600,
      dpr: 1,
    });
    expect(set.mock.calls).toEqual([[null], [null]]);
    expect(viewWhileDrawing.every((view) => !view)).toBe(true);
  });

  it('drops the view even when the build throws', () => {
    const { scene, context } = fixture({ cullSolMeleeOutsideView: true });
    const { hasView } = observe(scene);
    vi.spyOn(scene['spotAnimRenderer'], 'tick').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => scene.build(context, camera, { width: 800, height: 600, dpr: 1 })).toThrow('boom');
    expect(hasView()).toBe(false);
  });

  const MAC_SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  it.each([
    [
      'iPhone Safari',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      5,
      true,
    ],
    ['iPad on its desktop user agent', MAC_SAFARI, 5, true],
    ['Mac Safari', MAC_SAFARI, 0, false],
    [
      'Windows Chrome',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      0,
      false,
    ],
  ] as const)('is set by the Sol scene builder only on Apple touch devices: %s', (_, userAgent, maxTouchPoints, enabled) => {
    vi.stubGlobal('navigator', { userAgent, maxTouchPoints });
    const scene = createSolHereditSceneBuilder() as ColosseumSceneCompositor;
    scenes.push(scene);
    expect(scene['cullSolMeleeOutsideView']).toBe(enabled);
    // Batching Sol's effects and skipping the beams' zero-area parts go with it: the same policy,
    // the same devices. Melee is the first family, admitted first; the beams are the second.
    const beams = [
      ...COLOSSEUM_SPOTANIMS.crystalCharge,
      ...COLOSSEUM_SPOTANIMS.crystalFire,
      COLOSSEUM_SPOTANIMS.crystalImpact,
    ];
    const renderer = scene['spotAnimRenderer'];
    expect(renderer['batchFamilies'].map(({ ids }) => ids)).toEqual(
      enabled ? [[...COLOSSEUM_SPOTANIMS.solMelee], beams] : [],
    );
    expect([...renderer['zeroAreaSkipIds']]).toEqual(enabled ? beams : []);
  });
});

/**
 * Characterization of a recording in the old `colosseum_visual` wire shape (`legacySolRecording`),
 * drawn by the Sol scene builder. Observed only through the render queue and NPC poses, so this
 * block is meant to pass unchanged through every commit of the encounter-cue migration.
 */
describe('legacy colosseum_visual recording: continuous playback versus direct seek', () => {
  let recorded: readonly ReplayDisplayFrame[] | undefined;
  // Built inside the tests: constructing the engine sets the global arena, which `afterEach` resets.
  const legacyFrames = () => {
    recorded ??= legacySolRecording().frames;
    return recorded;
  };
  const idleSeqIds = new Set(SOL_HEREDIT_RENDER_CONFIG.preloadNpcTypes?.flatMap(({ idleSeqId }) => idleSeqId ?? []));
  const built: SceneCompositor[] = [];
  afterEach(() => {
    for (const scene of built.splice(0)) scene.dispose();
  });

  async function legacyScene() {
    const scene = createSolHereditSceneBuilder();
    if (!(scene instanceof SceneCompositor)) throw new Error('Expected a scene compositor');
    built.push(scene);
    const { loader, animation } = syntheticNpcAssets((id) => (id === SOL_NPC_ID ? 5 : 1));
    await scene.loadNpc(loader, animation);
    installSyntheticSpotAnims(scene, COLOSSEUM_SPOT_ANIM_IDS);
    const context = {
      speedMultiplier: 1,
      interaction: { hoveredTile: null, targetTile: null },
      options: SCENE_OPTIONS,
    };
    return (cycle: number, paused = false) =>
      observeScene(
        scene,
        scene.build({ ...context, ...replayContextAt(legacyFrames(), cycle, paused) }, projection, VIEWPORT),
      );
  }

  async function continuous(cycle: number, step = 5): Promise<SceneObservation> {
    const at = await legacyScene();
    for (let shown = 0; shown < cycle; shown += step) at(shown);
    return at(cycle);
  }

  const seek = async (cycle: number) => (await legacyScene())(cycle, true);
  const cued = ({ poses }: SceneObservation) =>
    Object.fromEntries(Object.entries(poses).filter(([, pose]) => !idleSeqIds.has(pose.seqId)));
  const effect = (spotAnimId: number, frame: number, at: [number, number, number]) => ({ spotAnimId, frame, at });
  const sand = (frames: readonly [number, number, number]) =>
    frames.map((frame, index) => effect(2698, frame, [28.5 + index, 30.5, 0]));

  it.each([
    // The shield telegraph, delayed 12 cycles to 42; the sand burst lit at once.
    { cycle: 45, poses: { [PRIMARY_NPC_ACTOR_ID]: { seqId: 10885, frame: 1 } }, effects: sand([0, 0, 0]) },
    // Each tile keeps its own ripple delay (0, 2 and 4 cycles).
    { cycle: 50, poses: { [PRIMARY_NPC_ACTOR_ID]: { seqId: 10885, frame: 2 } }, effects: sand([1, 0, 0]) },
    {
      // The graphic attached to Sol rides his rendered center at its own height; the one attached
      // to an actor that never renders is not drawn at all.
      cycle: 69,
      poses: {},
      effects: [effect(2668, 0, [33.5, 38.5, 0.5]), ...sand([1, 1, 1])],
    },
    {
      cycle: 80,
      poses: {},
      effects: [effect(130, 0, [20.5, 20.75, 1.3018]), effect(2668, 0, [33.5, 38.5, 0.5]), ...sand([2, 2, 2])],
    },
    {
      // Each beam's segments and its terminal impact, each on its own delay.
      cycle: 155,
      poses: {},
      effects: [
        effect(2695, 2, [24.5, 21.5, 1]),
        effect(2695, 2, [24.5, 22.5, 1]),
        effect(2696, 2, [23.5, 23.5, 1]),
        effect(2696, 2, [24.5, 23.5, 1]),
        effect(2697, 2, [24.5, 23.5, 1]),
        effect(2697, 2, [25.5, 23.5, 1]),
      ],
    },
  ])('shows the same cues at cycle $cycle whether played or sought', async ({ cycle, poses, effects }) => {
    for (const observation of [await continuous(cycle), await seek(cycle)]) {
      expect(cued(observation)).toEqual(poses);
      expect(observation.effects).toEqual(effects);
      expect(observation.drawnNpcs).toEqual([PRIMARY_NPC_ACTOR_ID]);
    }
  });

  it('starts and ends every flight, graphic and cued clip on the same cycles whether played or sought', async () => {
    const at = await legacyScene();
    const played = activeWindows((cycle) => at(cycle), 0, 200, idleSeqIds);
    // 2667 is attached to an actor that never renders, so it never draws.
    const effects = {
      2698: [30, 93],
      2668: [66, 125],
      130: [70, 89],
      131: [90, 149],
      2695: [93, 158],
      2696: [93, 158],
      2697: [99, 158],
    };
    const clips = { [`${PRIMARY_NPC_ACTOR_ID}:10885`]: [42, 51] };
    expect(played).toEqual({ effects, clips });
    const sought = async (cycle: number) => {
      const observation = await seek(cycle);
      return [
        ...observation.effects.map(({ spotAnimId }) => String(spotAnimId)),
        ...Object.entries(cued(observation)).map(([actorId, { seqId }]) => `${actorId}:${seqId}`),
      ];
    };
    // 131, on the player, is sought by the first-frame tests below.
    const { 131: _player, ...seekable } = effects;
    for (const [key, [first, last]] of Object.entries({ ...seekable, ...clips })) {
      expect(await sought(first - 1), `${key} before ${first}`).not.toContain(key);
      expect(await sought(first), `${key} at ${first}`).toContain(key);
      expect(await sought(last), `${key} at ${last}`).toContain(key);
      expect(await sought(last + 1), `${key} after ${last}`).not.toContain(key);
    }
  });

  // A baseline failure on 49ef532: the first frame after a seek resolved graphics attached to the
  // player before the player's rendered tile was known, so it hid the impact on the player (131,
  // cycles 90-149). The cue player places graphics once the player's position is resolved.
  it('draws a graphic attached to the player on the first frame of a direct seek', async () => {
    expect((await seek(95)).effects.map(({ spotAnimId }) => spotAnimId)).toContain(131);
  });

  it('starts and ends the graphic on the player on its played cycles when sought, on its tile', async () => {
    const onPlayer = async (cycle: number) =>
      (await seek(cycle)).effects.filter(({ spotAnimId }) => spotAnimId === 131).map(({ at }) => at);
    const tile: [number, number, number] = [LEGACY_SOL.playerTile[0] + 0.5, LEGACY_SOL.playerTile[1] + 0.5, 0.9688];
    expect([await onPlayer(89), await onPlayer(90), await onPlayer(149), await onPlayer(150)]).toEqual([
      [],
      [tile],
      [tile],
      [],
    ]);
  });
});
