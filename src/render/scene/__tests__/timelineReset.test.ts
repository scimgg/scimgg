import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, EventAudioPlayer, FrameSoundTracker } from '../../../audio';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import { isYamaSnapshot } from '../../../core/encounters/snapshot';
import type { GameEvent } from '../../../core/events/types';
import type { ReplayDisplayFrame } from '../../../core/ReplayRecorder';
import { ReplayFrameStore } from '../../../core/replayFrameStore';
import { MAX_REPLAY_PROJECTILE_STEPS, ReplaySafetyError } from '../../../core/replaySafety';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { getPlayerBlockAnimations, PLAYER_EAT_SEQ_ID } from '../../../data/weaponAnimations';
import { getWeaponCombatVisuals } from '../../../data/weaponCombatVisuals';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { YamaEncounter } from '../../../encounters/yamaP3/YamaEncounter';
import { SeqSoundEffect, SeqType } from '../../../rs/config/seqtype/SeqType';
import { SpotAnimID } from '../../../rs/config/spotanimtype/SpotAnimID';
import { ModelData } from '../../../rs/model/ModelData';
import type { RestoredPresentation } from '../../../types/restoredPresentation';
import type { NpcSnapshot, NpcState } from '../../../types/simulation';
import { AnimationSystem } from '../../backends/picogl/AnimationSystem';
import type { Projection2D } from '../../core/camera';
import type { RenderQueue } from '../../core/commands';
import { NpcVisualTracker } from '../../core/interpolation';
import { getReplayPresentation } from '../../core/replayPresentation';
import { playerAttackSequenceIds } from '../../core/replayPrimaryCues';
import { WAVE_PRELOAD_IDS } from '../../effects/controllers/WaveController';
import { SpotAnimRenderer } from '../../effects/SpotAnimRenderer';
import { registerType, seed } from '../../npc/__tests__/npcFacingTestHarness';
import type { FrameClipRef, NpcAnimationSet } from '../../npc/animationTypes';
import { NpcAnimationController } from '../../npc/NpcAnimationController';
import { NpcInstanceManager } from '../../npc/NpcInstanceManager';
import { PlayerAnimationController } from '../../player/PlayerAnimationController';
import type { PlayerAnimationUpdateInput, PlayerAnimModelAdapter } from '../../player/playerAnimationTypes';
import * as renderUtils from '../../shared/renderUtils';
import { SceneCompositor } from '../SceneCompositor';
import type { RenderContext } from '../types';
import { YamaSceneCompositor } from '../YamaSceneCompositor';

/**
 * A Yama scene whose declared effects have settled, as a replay needs before it presents anything:
 * each is cached with nothing to draw, so the tests' own subjects are all that renders.
 */
function yamaScene(): YamaSceneCompositor {
  const yama = new YamaSceneCompositor();
  for (const spotAnimId of WAVE_PRELOAD_IDS)
    yama['spotAnimRenderer']['meshCache'].set(spotAnimId, {
      static: [],
      frames: [],
      frameLengths: [],
      frameStep: -1,
      heightOffset: 0,
    });
  return yama;
}

const initialArena = getArenaConfig();
const initialAllowUnbounded = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(initialArena, initialAllowUnbounded));

describe('SceneCompositor timeline-discontinuity reset registry', () => {
  it('invokes every registered participant with the discontinuity reason', () => {
    const compositor = new SceneCompositor();
    const spy = vi.fn();
    (compositor as any).registerTransientReset('spy', spy);

    (compositor as any).resetTransientState('forward-jump');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('forward-jump');
  });

  it('base participant resets all base-owned transient state, rewind included', () => {
    const compositor = new SceneCompositor();
    (compositor as any).lastProcessedEventId = 42;
    (compositor as any).lastPlayedAudioEventId = 42;
    (compositor as any)._introAnimPlaying = true;
    (compositor as any)._introAnimStarted = true;
    (compositor as any)._introAnimComplete = true;
    (compositor as any).pendingIntroSeqId = 99;
    (compositor as any).pendingPlayerAttack = { kind: 'weapon', weaponId: 1 };
    (compositor as any).projectileTargetId = 'yama';
    const npcReset = vi.spyOn((compositor as any).npcInstanceManager, 'resetTransientState');

    (compositor as any).resetTransientState('rewind');

    // lastProcessedEventId === -1 is the ordering invariant: the next
    // getUnprocessedEvents re-consumes the landed frame's own events after a jump.
    expect((compositor as any).lastProcessedEventId).toBe(-1);
    expect((compositor as any).lastPlayedAudioEventId).toBe(-1);
    expect((compositor as any)._introAnimPlaying).toBe(false);
    expect((compositor as any)._introAnimStarted).toBe(false);
    expect((compositor as any)._introAnimComplete).toBe(false);
    expect((compositor as any).pendingIntroSeqId).toBeNull();
    expect((compositor as any).pendingPlayerAttack).toBeNull();
    expect((compositor as any).projectileTargetId).toBeNull();
    expect(npcReset).toHaveBeenCalledTimes(1);
  });

  it('starts the NPC animation clock on a whole cycle, never runs it back, bounds catch-up and resets it', () => {
    const compositor = new SceneCompositor();
    const clock = compositor as unknown as {
      npcAnimationCycle: number | null;
      startNpcAnimationClock(cycle: number): number;
      advanceNpcAnimationClock(cycle: number): void;
      resetTransientState(reason: 'rewind'): void;
    };
    const update = vi.spyOn((compositor as any).npcInstanceManager, 'updateAnimations');
    const stepped = () => update.mock.calls.reduce((total, [deltaMs]) => total + (deltaMs as number), 0);

    // A restore lands mid-cycle: the clock starts at cycle 67, so actors pick up the half cycle.
    clock.advanceNpcAnimationClock(67.5);
    expect(stepped()).toBe(10);
    expect(clock.npcAnimationCycle).toBe(67.5);
    expect(clock.startNpcAnimationClock(0)).toBe(67.5);
    clock.advanceNpcAnimationClock(75);
    expect(stepped()).toBe(160);
    clock.advanceNpcAnimationClock(70);
    expect(stepped()).toBe(160);
    expect(clock.npcAnimationCycle).toBe(75);
    update.mockClear();
    clock.advanceNpcAnimationClock(75 + 1e9);
    expect(stepped()).toBe(3000 * 20);
    expect(update.mock.calls.every(([deltaMs]) => (deltaMs as number) <= 50 * 20)).toBe(true);
    expect(clock.npcAnimationCycle).toBe(75 + 1e9);

    clock.resetTransientState('rewind');
    expect(clock.npcAnimationCycle).toBeNull();
    expect(clock.startNpcAnimationClock(30)).toBe(30);
  });

  it('resets the player animation controller and clears live spot anims on a discontinuity', () => {
    const compositor = new SceneCompositor();
    const playerAnimReset = vi.fn();
    (compositor as any).playerAnimController = { reset: playerAnimReset };
    const spotAnimClear = vi.spyOn((compositor as any).spotAnimRenderer, 'clearActiveInstances');

    (compositor as any).resetTransientState('rewind');

    expect(playerAnimReset).toHaveBeenCalledTimes(1);
    expect(spotAnimClear).toHaveBeenCalledTimes(1);
  });

  it('tolerates a discontinuity before the player model has loaded', () => {
    const compositor = new SceneCompositor();
    expect((compositor as any).playerAnimController).toBeNull();

    expect(() => (compositor as any).resetTransientState('timeline-change')).not.toThrow();
  });

  it('resetIntroState routes through the same base reset', () => {
    const compositor = new SceneCompositor();
    (compositor as any).lastProcessedEventId = 7;
    (compositor as any).lastPlayedAudioEventId = 7;
    (compositor as any).pendingPlayerAttack = { kind: 'weapon', weaponId: 1 };

    compositor.resetIntroState();

    expect((compositor as any).lastProcessedEventId).toBe(-1);
    expect((compositor as any).lastPlayedAudioEventId).toBe(-1);
    expect((compositor as any).pendingPlayerAttack).toBeNull();
  });
});

describe('YamaSceneCompositor registered reset participants', () => {
  it('clears Yama transient render/audio state on a discontinuity', () => {
    const yama = new YamaSceneCompositor();

    (yama as any)._fadedDamageEntries.add({ tick: 1 });
    (yama as any)._fadedDamageHistoryLen = 3;
    (yama as any).yamaAttackOutlineEndTick = 50;
    (yama as any).yamaAttackOutlineIsMagic = true;
    const frameSoundReset = vi.fn();
    (yama as any).frameSoundTracker = { reset: frameSoundReset };

    const waveClear = vi.spyOn((yama as any).waveController, 'clearActive');
    const attackClear = vi.spyOn((yama as any).attackController, 'clearActive');
    const fireballClear = vi.spyOn((yama as any).fireballController, 'clearActive');
    const voidFlareClear = vi.spyOn((yama as any).voidFlareController, 'clearActive');

    (yama as any).resetTransientState('rewind');

    expect((yama as any)._fadedDamageEntries.size).toBe(0);
    expect((yama as any)._fadedDamageHistoryLen).toBe(0);
    expect((yama as any).yamaAttackOutlineEndTick).toBeUndefined();
    expect((yama as any).yamaAttackOutlineIsMagic).toBe(false);
    expect(frameSoundReset).toHaveBeenCalledTimes(1);
    expect(waveClear).toHaveBeenCalledTimes(1);
    expect(attackClear).toHaveBeenCalledTimes(1);
    expect(fireballClear).toHaveBeenCalledTimes(1);
    expect(voidFlareClear).toHaveBeenCalledTimes(1);
  });

  it('runs the base reset participant too (subclass does not lose base behavior)', () => {
    const yama = new YamaSceneCompositor();
    (yama as any).lastProcessedEventId = 5;

    (yama as any).resetTransientState('forward-jump');

    expect((yama as any).lastProcessedEventId).toBe(-1);
  });

  it('resetIntroState runs the full registry (base + Yama participants)', () => {
    const yama = new YamaSceneCompositor();
    (yama as any)._fadedDamageEntries.add({ tick: 1 });
    (yama as any).yamaAttackOutlineEndTick = 50;
    (yama as any).lastProcessedEventId = 9;
    const waveClear = vi.spyOn((yama as any).waveController, 'clearActive');

    yama.resetIntroState();

    expect((yama as any)._fadedDamageEntries.size).toBe(0);
    expect((yama as any).yamaAttackOutlineEndTick).toBeUndefined();
    expect((yama as any).lastProcessedEventId).toBe(-1);
    expect(waveClear).toHaveBeenCalledTimes(1);
  });
});

describe('NpcInstanceManager.resetTransientState', () => {
  it('drops in-flight death fades, resets attack-trigger dedup, and resets anim controllers', () => {
    const manager = new NpcInstanceManager();
    const liveReset = vi.fn();

    (manager as any).instanceRegistry.set('live', {
      actorId: 'live',
      animController: { reset: liveReset },
      lastAttackTriggerTick: 5,
    });
    // A dying instance that must NOT survive the reset (otherwise a corpse
    // renders alongside the live NPC after seeking back before its death — B3).
    (manager as any).dyingInstances.set('dead', {
      instance: { animController: null },
      deathTimerMs: 100,
      deathDurationMs: 600,
    });

    manager.resetTransientState();

    expect((manager as any).dyingInstances.size).toBe(0);
    expect((manager as any).instanceRegistry.get('live').lastAttackTriggerTick).toBe(-1);
    expect(liveReset).toHaveBeenCalledTimes(1);
  });
});

describe('SpotAnimRenderer.clearActiveInstances', () => {
  it('drops every live instance and group but keeps the loaded mesh cache', () => {
    const renderer = new SpotAnimRenderer();
    renderer['meshCache'].set(1234, { static: [], frames: [], frameLengths: [], frameStep: -1, heightOffset: 0 });
    renderer.spawn({
      instanceId: 'a',
      spotAnimId: 1234,
      groupId: 'g',
      lifecycle: { kind: 'manual' },
      transform: { kind: 'static', value: { position: [0, 0, 0] } },
    });

    renderer.clearActiveInstances();

    expect(renderer['activeInstances'].size).toBe(0);
    expect(renderer['groups'].size).toBe(0);
    // dispose() would also nuke this; a seek must not force a model reload.
    expect(renderer['meshCache'].size).toBe(1);
  });
});

describe('PlayerAnimationController.reset', () => {
  const seq = (id: number) =>
    ({
      id,
      frameIds: [10, 11, 12],
      frameLengths: [1, 1, 1],
      masks: null,
      priority: 5,
      precedenceAnimating: 5,
      heightOffset: 0,
    }) as any;

  const IDLE_SEQ_ID = 1;
  const ATTACK_SEQ_ID = 3;

  function makeController() {
    const modelAdapter: PlayerAnimModelAdapter = {
      resetPose: vi.fn(),
      applyFrame: vi.fn(),
      applyFrameInterleaved: vi.fn(),
      commitPose: vi.fn(),
      applyMesh: vi.fn(),
    };
    const controller = new PlayerAnimationController({
      playerModelData: {
        mergedModel: { verticesCount: 1, verticesY: new Int32Array([0]), faceCount: 0 },
        litColors: null,
      } as any,
      animationSet: {
        idle: seq(IDLE_SEQ_ID),
        walk: seq(2),
        run: null,
        turnLeft: null,
        turnRight: null,
        walkBack: null,
        idleTurnLeft: null,
        idleTurnRight: null,
        attack: seq(ATTACK_SEQ_ID),
      } as any,
      modelAdapter,
    });
    return { controller, modelAdapter };
  }

  const input = (deltaMs: number): PlayerAnimationUpdateInput => ({
    deltaMs,
    isMoving: false,
    simIsMoving: false,
    isRunning: false,
    visualAngle: 0,
    targetAngle: 0,
    speedMultiplier: 1,
    isTurning: false,
  });

  it('drops a mid-flight primary attack animation', () => {
    const { controller } = makeController();
    controller.triggerAttack();
    controller.updatePlayerAnimation(input(20));
    expect(controller.getFrameState()?.seqId).toBe(ATTACK_SEQ_ID);

    controller.reset();

    expect(controller.getFrameState()?.seqId).toBe(IDLE_SEQ_ID);
    expect(controller.getPrimaryAnimMovementBlock()).toEqual({ blocksRunning: false, blocksWalking: false });
  });

  it('drops queued signals that have not been consumed yet', () => {
    const { controller } = makeController();
    controller.triggerAttack();

    controller.reset();
    controller.updatePlayerAnimation(input(20));

    // Without the queue drain the attack would fire on the post-seek timeline.
    expect(controller.getFrameState()?.seqId).toBe(IDLE_SEQ_ID);
  });

  it('commits a pose on the next zero-delta update after dropping a live animation', () => {
    const { controller, modelAdapter } = makeController();
    controller.triggerAttack();
    controller.updatePlayerAnimation(input(20));
    vi.mocked(modelAdapter.commitPose).mockClear();

    // A paused replay frame passes deltaMs: 0, which normally early-returns.
    controller.updatePlayerAnimation(input(0));
    expect(modelAdapter.commitPose).not.toHaveBeenCalled();

    controller.reset();
    controller.updatePlayerAnimation(input(0));

    expect(modelAdapter.commitPose).toHaveBeenCalledTimes(1);
  });

  it('PERF: resetting an already-idle player rebuilds nothing', () => {
    const { controller, modelAdapter } = makeController();
    controller.updatePlayerAnimation(input(20));
    vi.mocked(modelAdapter.commitPose).mockClear();
    vi.mocked(modelAdapter.resetPose).mockClear();

    // A scrub fires one reset + build per animation frame. An idle player must
    // not pay a full pose/mesh rebuild on any of them.
    for (let i = 0; i < 30; i++) {
      controller.reset();
      controller.updatePlayerAnimation(input(0));
    }

    expect(modelAdapter.commitPose).not.toHaveBeenCalled();
    expect(modelAdapter.resetPose).not.toHaveBeenCalled();
  });

  it('PERF: reset does not rewind a free-running idle loop', () => {
    const { controller } = makeController();
    controller.updatePlayerAnimation(input(20));
    controller.updatePlayerAnimation(input(20));
    const before = controller.getFrameState()?.currentFrameIndex;
    expect(before).toBeGreaterThan(0);

    controller.reset();

    expect(controller.getFrameState()?.currentFrameIndex).toBe(before);
  });
});

describe('NpcVisualTracker.snap', () => {
  it('snaps the visual angle straight to the target with no interpolation', () => {
    const tracker = new NpcVisualTracker(0);
    tracker.setTarget(1024);

    // Without snapping, advance(0) keeps the stale visual angle (0).
    expect(tracker.advance(0).facingAngle).toBe(0);

    tracker.snap();

    const state = tracker.advance(0);
    expect(state.facingAngle).toBe(1024);
    expect(state.isTurning).toBe(false);
  });

  it('snaps to an explicit target angle when provided', () => {
    const tracker = new NpcVisualTracker(0);
    tracker.snap(512);
    expect(tracker.advance(0).facingAngle).toBe(512);
  });
});

describe('SceneCompositor honors the timeline.paused contract', () => {
  // build() suppresses event audio while paused. We drive build() only as far as
  // that early gate (it runs before any GL/render path); the later full-render
  // path throws without model/GL setup, which is irrelevant to this assertion.
  function makeMinimalCtx(opts: { paused?: boolean; useTimeline: boolean }): RenderContext {
    const simulationState = {
      currentTick: 10,
      playerPosition: [30, 30],
      primaryNpcPosition: [29, 28],
      mechanicsConfig: {},
      npcs: [],
    } as any;
    const options = {
      renderMode: '2d',
      showCoordinates: false,
      showNpcClickbox: false,
      showTileMarkers: false,
      showTileMarkerLabels: false,
      smoothTerrain: false,
      brightness: 1,
      contrast: 1,
      saturation: 1,
      encounterDebugFlags: {},
    } as any;
    return {
      simulationState,
      events: [{ eventId: 1, tick: 10, type: 'noop_event' } as any],
      options,
      interaction: { hoveredTile: null, targetTile: null },
      interpolatedTick: 10,
      speedMultiplier: 1,
      ...(opts.useTimeline
        ? { timeline: { timelineKey: 'k', paused: opts.paused ?? false } }
        : { replayPaused: opts.paused }),
    } as unknown as RenderContext;
  }

  function runToAudioGate(compositor: SceneCompositor, ctx: RenderContext) {
    const audioPlayer = new EventAudioPlayer(new AudioEngine());
    const onEvents = vi.spyOn(audioPlayer, 'onEvents');
    compositor.setEventAudioPlayer(audioPlayer);
    try {
      compositor.build(ctx, {} as any, {} as any);
    } catch {
      // Full-render path past the audio gate may throw without GL setup.
    }
    return onEvents;
  }

  it('suppresses event audio when timeline.paused is true (replayPaused unset)', () => {
    const onEvents = runToAudioGate(new SceneCompositor(), makeMinimalCtx({ paused: true, useTimeline: true }));
    expect(onEvents).not.toHaveBeenCalled();
  });

  it('plays event audio when timeline.paused is false', () => {
    const onEvents = runToAudioGate(new SceneCompositor(), makeMinimalCtx({ paused: false, useTimeline: true }));
    expect(onEvents).toHaveBeenCalledTimes(1);
  });

  it('honors the replayPaused flag when no timeline is present', () => {
    const onEvents = runToAudioGate(new SceneCompositor(), makeMinimalCtx({ paused: true, useTimeline: false }));
    expect(onEvents).not.toHaveBeenCalled();
  });

  it('does not consume paused replay audio events before the same frame is built unpaused', () => {
    const compositor = new SceneCompositor();
    const pausedEvents = runToAudioGate(compositor, makeMinimalCtx({ paused: true, useTimeline: true }));

    expect(pausedEvents).not.toHaveBeenCalled();

    const unpausedEvents = runToAudioGate(compositor, makeMinimalCtx({ paused: false, useTimeline: true }));
    expect(unpausedEvents).toHaveBeenCalledTimes(1);
    expect(unpausedEvents.mock.calls[0]?.[0]).toEqual([{ eventId: 1, tick: 10, type: 'noop_event' }]);
  });

  it('does not replay audio events when the same unpaused frame is built again', () => {
    const compositor = new SceneCompositor();

    const firstBuildEvents = runToAudioGate(compositor, makeMinimalCtx({ paused: false, useTimeline: true }));
    const duplicateBuildEvents = runToAudioGate(compositor, makeMinimalCtx({ paused: false, useTimeline: true }));

    expect(firstBuildEvents).toHaveBeenCalledTimes(1);
    expect(duplicateBuildEvents).not.toHaveBeenCalled();
  });
});

describe('SceneCompositor bounded tile geometry', () => {
  let scene: SceneCompositor;
  let heightReads: number;
  let projectedTiles: Array<[number, number]>;
  const projection: Projection2D = {
    tileToScreen: (tile) => tile,
    tileDeltaToScreen: (delta) => delta,
    screenToTile: () => null,
    tilePolygonScreen: ({ x, y }) => {
      if (projectedTiles.length >= 1000) expect.fail('Footprint exceeded terrain work budget');
      projectedTiles.push([x, y]);
      return [
        { x, y },
        { x: x + 1, y },
        { x: x + 1, y: y + 1 },
        { x, y: y + 1 },
      ];
    },
  };

  beforeEach(() => {
    scene = new SceneCompositor();
    scene['terrainBounds'] = { minX: -2, maxX: 3, minY: -1, maxY: 4, width: 6, height: 6 };
    scene['terrainHeights'] = Array.from({ length: 65 }, () => new Int32Array(65).fill(-128));
    heightReads = 0;
    projectedTiles = [];
    const original = renderUtils.getTerrainHeight;
    vi.spyOn(renderUtils, 'getTerrainHeight').mockImplementation((...args) => {
      if (++heightReads > 1000) expect.fail('Outline exceeded terrain work budget');
      return original(...args);
    });
  });

  afterEach(() => {
    scene.dispose();
    vi.restoreAllMocks();
  });

  it.each([
    [3e16, 5, 3e16, 5],
    [5, 3e16, 5, 3e16],
    [-1e9, -1e9, 1e9, 1e9],
  ])('emits no invented border when original edges are outside (%s, %s, %s, %s)', (minX, minY, maxX, maxY) => {
    const mesh = scene['createOutlineMesh3D'](minX, minY, maxX, maxY, 123);

    expect(mesh.positions).toHaveLength(0);
    expect(heightReads).toBe(0);
  });

  it('clips each original edge without closing the clipped rectangle', () => {
    const mesh = scene['createOutlineMesh3D'](-1e9, 1, 1e9, 2, 123, 0.04);

    expect(mesh.positions).toHaveLength(12 * 18);
    const positions = mesh.positions;
    for (let vertex = 0; vertex < positions.length; vertex += 3) {
      expect(positions[vertex]).toBeGreaterThanOrEqual(-2);
      expect(positions[vertex]).toBeLessThanOrEqual(4);
      expect(Math.min(Math.abs(positions[vertex + 1] - 1), Math.abs(positions[vertex + 1] - 3))).toBeCloseTo(0.02);
      expect(positions[vertex + 2]).toBeCloseTo(1.01);
    }
  });

  it('preserves negative-coordinate perimeter, corner fills, width, height and opacity', () => {
    const mesh = scene['createOutlineMesh3D'](-2, -1, -1, 0, 123, 0.04, 7, 0.5);

    expect(mesh.positions).toHaveLength(12 * 18);
    expect(mesh.positions.slice(0, 18)).toEqual(
      new Float32Array([
        -2, -1.02, 1.01, -1, -1.02, 1.01, -1, -0.98, 1.01, -2, -1.02, 1.01, -1, -0.98, 1.01, -2, -0.98, 1.01,
      ]),
    );
    expect(mesh.positions.slice(8 * 18, 9 * 18)).toEqual(
      new Float32Array([
        -2, -1, 1.01, -2.02, -1, 1.01, -2.02, -1.02, 1.01, -2, -1, 1.01, -2.02, -1.02, 1.01, -2, -1.02, 1.01,
      ]),
    );
    expect(mesh.perVertexAlphas).toEqual(new Float32Array(72).fill(0.5));
    expect(mesh.zIndex).toBe(7);
  });

  it('clips vertical original edges without inventing horizontal borders', () => {
    const mesh = scene['createOutlineMesh3D'](0, -1e9, 1, 1e9, 123, 0.04);

    expect(mesh.positions).toHaveLength(12 * 18);
    const positions = mesh.positions;
    for (let vertex = 0; vertex < positions.length; vertex += 3) {
      expect(Math.min(Math.abs(positions[vertex]), Math.abs(positions[vertex] - 2))).toBeCloseTo(0.02);
      expect(positions[vertex + 1]).toBeGreaterThanOrEqual(-1);
      expect(positions[vertex + 1]).toBeLessThanOrEqual(5);
    }
  });

  it.each([
    'trueTile',
    'clickbox',
  ] as const)('bounds %s 2D footprint work to terrain without dropping visible tiles', (mode) => {
    const npc: NpcSnapshot = {
      id: 'outline',
      npcTypeId: 1,
      archetypeId: 'test',
      role: 'npc',
      alive: true,
      position: [-1e9, -1e9],
      previousPosition: [0, 0],
      facingAngle: 0,
      size: 2e9,
      hp: 1,
      maxHp: 1,
    };
    const queue: RenderQueue = { commands: [], replayPresentationReady: true };

    scene['buildNpcHighlights'](
      queue,
      projection,
      [{ npcName: 'test', npcTypeId: 1, mode, color: '#ffffff' }],
      [npc],
      true,
    );

    expect(projectedTiles).toEqual(
      Array.from({ length: 6 }, (_, column) =>
        Array.from({ length: 6 }, (_, row): [number, number] => [column - 2, row - 1]),
      ).flat(),
    );
    expect(queue.commands).toHaveLength(36);
  });

  it.each(['trueTile', 'clickbox'] as const)('preserves ordinary %s footprints while skipping distant ones', (mode) => {
    const visible: NpcSnapshot = {
      id: 'outline',
      npcTypeId: 1,
      archetypeId: 'test',
      role: 'npc',
      alive: true,
      position: [-1, 0],
      previousPosition: [0, 0],
      facingAngle: 0,
      size: 2,
      hp: 1,
      maxHp: 1,
    };
    const distant: NpcSnapshot = { ...visible, id: 'distant', position: [3e16, 5], size: 1e9 };
    const queue: RenderQueue = { commands: [], replayPresentationReady: true };

    scene['buildNpcHighlights'](
      queue,
      projection,
      [{ npcName: 'test', npcTypeId: 1, mode, color: '#ffffff' }],
      [visible, distant],
      true,
    );

    expect(projectedTiles).toEqual([
      [-1, 0],
      [-1, 1],
      [0, 0],
      [0, 1],
    ]);
    expect(queue.commands).toHaveLength(4);
  });
});

describe('SceneCompositor replay delayed cues', () => {
  const events: GameEvent[] = [{ type: 'actor_died', eventId: 1, tick: 10, actorId: 'player' }];
  const projection: Projection2D = {
    tileToScreen: (tile) => tile,
    tileDeltaToScreen: (delta) => delta,
    screenToTile: () => null,
    tilePolygonScreen: () => [],
  };
  let engine: AudioEngine;
  let scene: SceneCompositor;
  let context: RenderContext;

  beforeEach(() => {
    engine = new AudioEngine();
    vi.spyOn(engine, 'play').mockImplementation(() => {});
    scene = new SceneCompositor();
    scene.setEventAudioPlayer(
      new EventAudioPlayer(engine, {
        name: 'delayed',
        rules: { actor_died: { resolve: { id: 10313, delayCycles: 21 } } },
      }),
    );
    const state = new SimulationEngine({ encounter: new LobbyEncounter(), combatSeed: 1 }).getState();
    context = {
      simulationState: { ...state, currentTick: 10, npcs: [] },
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
      interpolatedTick: 10,
      speedMultiplier: 1,
      timeline: { timelineKey: 'replay', paused: false },
      replayHistory: { frames: [{ state, events }], throughFrameIndex: 0 },
    };
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
    vi.restoreAllMocks();
  });

  function draw(timeMs: number, overrides: Partial<RenderContext> = {}): void {
    scene.build(
      {
        ...context,
        simulationState: { ...context.simulationState, currentTick: Math.floor(timeMs / 600) },
        interpolatedTick: timeMs / 600,
        ...overrides,
      },
      projection,
      { width: 800, height: 600, dpr: 1 },
    );
  }

  it.each([
    { x: 3e16, size: 1 },
    { x: 5, size: 1e9 },
  ])('bounds paused imported outlines with highlights disabled at $x / $size', ({ x, size }) => {
    scene['terrainHeights'] = Array.from({ length: 65 }, () => new Int32Array(65));
    const original = renderUtils.getTerrainHeight;
    let reads = 0;
    vi.spyOn(renderUtils, 'getTerrainHeight').mockImplementation((...args) => {
      if (++reads > 1000) expect.fail('Paused scene exceeded outline work budget');
      return original(...args);
    });
    const state: RenderContext['simulationState'] = {
      ...context.simulationState,
      npcs: [
        {
          id: 'imported-outline',
          npcTypeId: 1,
          archetypeId: 'test',
          role: 'npc',
          alive: true,
          position: [x, 5],
          previousPosition: [x, 5],
          facingAngle: 0,
          size,
          hp: 1,
          maxHp: 1,
          history: new Map<number, [number, number]>(),
          outline: { style: 'full', color: 123 },
        },
      ],
    };

    const queue = scene.build(
      {
        ...context,
        simulationState: state,
        events: [],
        options: { ...context.options, showNpcHighlights: false },
        timeline: { timelineKey: 'imported-outline', paused: true },
        replayHistory: { frames: [{ state, events: [] }], throughFrameIndex: 0 },
      },
      projection,
      { width: 800, height: 600, dpr: 1 },
    );

    const outlines = queue.commands.filter(
      (command) => command.kind === 'mesh3d' && command.meshId.startsWith(`outline-${x}-5-`),
    );
    expect(outlines).toHaveLength(1);
    const outline = outlines[0];
    if (!outline || !('positions' in outline) || !(outline.positions instanceof Float32Array)) {
      expect.fail('Missing imported outline geometry');
    }
    expect(outline.positions.length).toBeLessThanOrEqual(2400);
    expect(reads).toBeLessThan(1000);
  });

  it('owns one projectile allowance for the whole build and releases it after a failed build', () => {
    let fail = true;
    scene['onEncounterEvents'] = () => {
      const work = scene['replayProjectileWork'];
      if (!work) expect.fail('Missing compositor projectile allowance');
      work.charge(MAX_REPLAY_PROJECTILE_STEPS - 1);
    };
    vi.spyOn(scene['projectileController'], 'update').mockImplementation(
      (_renderer, _currentTick, _interpolatedTick, _loader, _facing, _resolver, work) => {
        if (!work) expect.fail('Missing explicit player projectile allowance');
        work.charge(fail ? 2 : 1);
      },
    );

    expect(() => draw(6000)).toThrowError(
      new ReplaySafetyError('projectile-work-limit', {
        actual: MAX_REPLAY_PROJECTILE_STEPS + 1,
        limit: MAX_REPLAY_PROJECTILE_STEPS,
      }),
    );
    expect(scene['replayProjectileWork']).toBeUndefined();
    fail = false;
    expect(() => draw(6000)).not.toThrow();
    expect(scene['replayProjectileWork']).toBeUndefined();
  });

  function installPlayer(target = scene) {
    const system = new AnimationSystem();
    const types = new Map<number, SeqType>();
    const type = (id: number) => {
      let result = types.get(id);
      if (!result) {
        result = new SeqType(id, {
          name: 'test',
          game: 'oldschool',
          environment: 'test',
          revision: 0,
          timestamp: '',
          size: 0,
        });
        result.frameIds = [id * 10, id * 10 + 1, id * 10 + 2, id * 10 + 3];
        result.frameLengths = [30, 30, 30, 30];
        result.forcedPriority = id === 440 ? 6 : 5;
        types.set(id, result);
      }
      return result;
    };
    const lookup = vi.spyOn(system, 'loadSeqType').mockImplementation(type);
    target.setAnimationSystem(system);
    const idle = system.createSequenceFromSeqType(type(808));
    if (!idle) expect.fail('Missing idle fixture');
    const adapter: PlayerAnimModelAdapter = {
      resetPose: vi.fn(),
      applyFrame: vi.fn(),
      applyFrameInterleaved: vi.fn(),
      commitPose: vi.fn(),
      applyMesh: vi.fn(),
    };
    const controller = new PlayerAnimationController({
      playerModelData: {
        mergedModel: new ModelData(),
        litColors: { faceColors1: new Int32Array(), faceColors2: new Int32Array(), faceColors3: new Int32Array() },
        weaponShieldFaceMask: new Uint8Array(),
        subModelFaceCounts: [],
      },
      animationSet: {
        idle,
        walk: idle,
        run: idle,
        turnLeft: idle,
        turnRight: idle,
        walkBack: idle,
        idleTurnLeft: idle,
        idleTurnRight: idle,
      },
      modelAdapter: adapter,
    });
    target['playerAnimController'] = controller;
    return { controller, adapter, system, lookup, types, type };
  }

  it('shows the same takeover preflight and adopted endpoint without leaking next-snapshot actors or effects', () => {
    const { controller } = installPlayer();
    const visuals = getWeaponCombatVisuals(12926);
    if (!visuals) expect.fail('Missing existing projectile fixture');
    const renderer = scene['spotAnimRenderer'];
    for (const id of [123, 456, visuals.projectileId, visuals.hitSpotanim])
      if (id >= 0) {
        renderer['meshCache'].set(id, { static: [], frames: [], frameLengths: [120], frameStep: -1, heightOffset: 0 });
      }
    const target: NpcState = {
      id: 'target',
      npcTypeId: 0,
      archetypeId: 'test',
      role: 'npc',
      alive: true,
      size: 1,
      hp: 100,
      maxHp: 100,
      position: [45, 45],
      previousPosition: [45, 45],
      facingAngle: 0,
      history: new Map(),
    };
    const state = { ...context.simulationState, currentTick: 10, npcs: [target] };
    const attack: GameEvent = {
      type: 'attack_started',
      eventId: 2,
      tick: 10,
      sourceId: 'player',
      targetId: 'target',
      weaponId: 12926,
      attackKind: 'range_arrow',
      style: 'range',
    };
    const frames: ReplayDisplayFrame[] = [
      {
        state,
        events: [
          attack,
          { type: 'item_consumed', eventId: 3, tick: 10 },
          { type: 'player_graphic_applied', eventId: 4, tick: 10, spotAnimId: 123 },
        ],
      },
      { state: { ...state, currentTick: 11 }, events: [] },
      {
        state: {
          ...state,
          currentTick: 12,
          npcs: [
            { ...target, position: [25, 25] },
            { ...target, id: 'future-actor', spawnTick: 12 },
          ],
        },
        events: [
          { type: 'player_graphic_applied', eventId: 6, tick: 12, spotAnimId: 456 },
          { ...attack, eventId: 7, tick: 12 },
          { type: 'item_consumed', eventId: 8, tick: 12 },
        ],
      },
    ];
    const store = new ReplayFrameStore();
    store.setHistory(frames);
    const present = (completed = false) => {
      store.setPreview(completed ? { ...frames[1], frameIndex: 1, completedBoundary: true } : undefined);
      return getReplayPresentation(store.getSnapshot(), { ...frames[0], frameIndex: 0 });
    };
    const drawPresentation = (sample: ReturnType<typeof getReplayPresentation>) =>
      scene.build(
        {
          ...context,
          simulationState: sample.state,
          events: sample.events,
          playerVisual: sample.playerVisual,
          interpolatedTick: sample.interpolatedTick,
          replayHistory: sample.replayHistory,
          frameDeltaMs: 0,
          timeline: { timelineKey: 'full-replay', paused: true, timeMs: sample.timeMs },
        },
        projection,
        { width: 800, height: 600, dpr: 1 },
      );
    store.set(1200, undefined);
    drawPresentation(present());
    expect(scene['playerGraphicController']['activeGraphic']?.spotAnimId).toBe(456);
    store.set(600, undefined);
    const candidate = present(true);
    expect(candidate.frameIndex).toBe(1);
    expect(candidate.timeMs).toBe(7200);
    expect(candidate.replayHistory?.frames).toBe(frames);
    drawPresentation(candidate);
    const pose = () => ({
      actor: controller.getFrameState(),
      graphic: scene['playerGraphicController']['activeGraphic'],
      projectiles: [...scene['projectileController']['activeProjectiles'].values()].map(({ flight }) => ({
        id: flight.config.instanceId,
        transform: renderer['activeInstances'].get(flight.config.instanceId)?.transform,
      })),
    });
    expect(controller.getFrameState()?.currentFrameIndex).toBe(2);
    expect(scene['playerGraphicController']['activeGraphic']?.spotAnimId).toBe(123);
    expect(candidate.state.npcs.map((npc) => npc.id)).toEqual(['target']);
    expect(scene['projectileController']['activeProjectiles'].size).toBe(1);
    const chosenPose = structuredClone(pose());
    drawPresentation(present());
    expect(controller.getFrameState()?.currentFrameIndex).toBe(1);
    expect(store.getSnapshot().history).toBe(frames);
    expect(store.getSnapshot().playheadMs).toBe(600);
    drawPresentation(candidate);
    expect(pose()).toEqual(chosenPose);
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    const restoration: RestoredPresentation = {
      engine,
      tick: 11,
      timeMs: 7200,
      history: { frames: frames.slice(0, 2), throughFrameIndex: 1 },
    };
    for (const wallMs of [1000, 3000, 8000]) {
      vi.spyOn(performance, 'now').mockReturnValue(wallMs);
      scene.build(
        {
          ...context,
          simulationState: frames[1].state,
          events: frames[1].events,
          interpolatedTick: 12,
          frameDeltaMs: 0,
          replayHistory: undefined,
          restoredPresentation: restoration,
          timeline: { timelineKey: 'adopted-endpoint', paused: true, timeMs: restoration.timeMs },
        },
        projection,
        { width: 800, height: 600, dpr: 1 },
      );
      expect(pose()).toEqual(chosenPose);
    }
  });

  it.each([
    false,
    true,
  ])('initializes restored actors/projectiles/graphics once and hands them to live without resetting, first frame after GO=%s', (afterGo) => {
    const { controller } = installPlayer();
    const visual = getWeaponCombatVisuals(12926);
    if (!visual) expect.fail('Missing existing blowpipe visual fixture');
    const renderer = scene['spotAnimRenderer'];
    const graphicProgress = () => {
      const instance = renderer['activeInstances'].get('player-graphic-active');
      if (!instance) expect.fail('Historical graphic disappeared at adoption');
      return renderer['resolveFrameProgress'](instance, [120]);
    };
    for (const id of [123, visual.projectileId, visual.hitSpotanim]) {
      if (id >= 0)
        renderer['meshCache'].set(id, { static: [], frames: [], frameLengths: [120], frameStep: -1, heightOffset: 0 });
    }
    const target: NpcState = {
      id: 'target',
      npcTypeId: 0,
      archetypeId: 'test',
      role: 'npc',
      alive: true,
      position: [45, 45],
      previousPosition: [45, 45],
      facingAngle: 0,
      size: 1,
      hp: 100,
      maxHp: 100,
      history: new Map<number, [number, number]>([[10, [45, 45]]]),
    };
    const state: RenderContext['simulationState'] = { ...context.simulationState, currentTick: 10, npcs: [target] };
    const frames: ReplayDisplayFrame[] = [
      {
        state,
        events: [
          {
            type: 'attack_started',
            eventId: 2,
            tick: 10,
            sourceId: 'player',
            targetId: 'target',
            weaponId: 12926,
            attackKind: 'range_arrow',
            style: 'range',
          },
          { type: 'item_consumed', eventId: 3, tick: 10 },
          { type: 'player_graphic_applied', eventId: 4, tick: 10, spotAnimId: 123 },
        ],
      },
      { state: { ...state, currentTick: 11 }, events: [{ type: 'actor_died', eventId: 5, tick: 11, actorId: 'old' }] },
    ];
    const restoredEngine = new SimulationEngine({ encounter: new LobbyEncounter() });
    const restoration: RestoredPresentation = {
      engine: restoredEngine,
      tick: 11,
      timeMs: 12 * 600,
      history: { frames, throughFrameIndex: 1 },
    };
    const reset = vi.spyOn(scene['projectileController'], 'dispose');
    const audio = vi.spyOn(scene['eventAudioPlayer']!, 'onEvents');
    const drawRestored = (tick: number, fraction: number, paused: boolean, events: GameEvent[] = [], delta = 0) =>
      draw((tick + fraction) * 600, {
        simulationState: { ...state, currentTick: tick },
        events,
        replayHistory: undefined,
        restoredPresentation: restoration,
        frameDeltaMs: delta,
        timeline: { timelineKey: 'adopted-engine', paused, timeMs: (tick + fraction) * 600 },
      });
    const newEvents: GameEvent[] = [{ type: 'actor_died', eventId: 6, tick: 12, actorId: 'new' }];
    let heldMotion: unknown;
    if (!afterGo) {
      for (const wallMs of [1000, 3000, 7000]) {
        vi.spyOn(performance, 'now').mockReturnValue(wallMs);
        drawRestored(11, 1, true, newEvents);
        expect(controller.getFrameState()?.currentFrameIndex).toBe(2);
        expect(graphicProgress()).toBeCloseTo(0.5);
        const motion = [...scene['projectileController']['activeProjectiles'].values()][0]?.flight['motion'];
        if (heldMotion === undefined) heldMotion = structuredClone(motion);
        else expect(motion).toEqual(heldMotion);
      }
      expect(audio).not.toHaveBeenCalled();
      expect(engine.play).not.toHaveBeenCalled();
    }
    frames.push({ state: { ...state, currentTick: 12 }, events: newEvents });
    const phase = afterGo ? 0.25 : 0;
    drawRestored(12, phase, false, newEvents);
    const projectile = [...scene['projectileController']['activeProjectiles'].values()][0];
    expect(projectile).toBeDefined();
    if (!projectile) expect.fail('Historical projectile disappeared at adoption');
    expect(projectile.flight['cycle']).toBeGreaterThan(projectile.flight.config.startCycle);
    const motion = structuredClone(projectile.flight['motion']);
    if (!afterGo) expect(motion).toEqual(heldMotion);
    const projectilePosition = () => {
      const transform = renderer['activeInstances'].get(projectile.flight.config.instanceId)?.transform;
      if (!transform || transform.kind !== 'static') expect.fail('Missing restored projectile transform');
      return [...transform.value.position];
    };
    const renderedPosition = projectilePosition();
    const graphic = scene['playerGraphicController']['activeGraphic'];
    expect(controller.getFrameState()?.currentFrameIndex).toBe(2);
    expect(graphicProgress()).toBeCloseTo(0.5 + phase / 4);
    expect(reset).toHaveBeenCalledOnce();
    drawRestored(12, phase, false, newEvents);
    expect(reset).toHaveBeenCalledOnce();
    expect([...scene['projectileController']['activeProjectiles'].values()][0]).toBe(projectile);
    // Replay keeps an integer-cycle physics checkpoint internally. Compare the rendered
    // fractional position, not that checkpoint, when its sampler hands off to live motion.
    expect(projectilePosition()).toEqual(renderedPosition);
    expect(scene['playerGraphicController']['activeGraphic']).toBe(graphic);
    expect(audio).toHaveBeenCalledExactlyOnceWith(newEvents, state.playerPosition);
    expect(engine.play).toHaveBeenCalledExactlyOnceWith(
      10313,
      { channel: 'sfx', volume: 1, delayMs: 420 },
      'event:actor_died',
    );
    drawRestored(12, phase + 0.1, false, newEvents, 60);
    expect(reset).toHaveBeenCalledOnce();
    expect(projectilePosition()).not.toEqual(renderedPosition);
    expect(graphicProgress()).toBeGreaterThan(0.5 + phase / 4);
    const retiredAtTick = Math.max(14, Math.ceil(projectile.flight.config.endCycleExclusive / 30));
    for (let tick = 13; tick <= retiredAtTick; tick++) drawRestored(tick, 0, false);
    expect(scene['projectileController']['activeProjectiles'].size).toBe(0);
    expect(scene['playerGraphicController']['activeGraphic']).toBeNull();
    // A genuine subsequent timeline change still clears all transient state.
    draw(retiredAtTick * 600, {
      replayHistory: undefined,
      restoredPresentation: restoration,
      timeline: { timelineKey: 'different-scene', paused: false },
    });
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('restores historical weapon/style attacks despite a newer rejected block and destination equipment swap', () => {
    const { controller, lookup } = installPlayer();
    const attack: GameEvent = {
      type: 'attack_started',
      eventId: 2,
      tick: 10,
      sourceId: 'player',
      targetId: 'npc',
      weaponId: 11889,
      attackKind: 'melee_slash',
      style: 'melee',
    };
    const frames: ReplayDisplayFrame[] = [
      { state: { ...context.simulationState, playerEquipment: { weapon: 11889 } }, events: [attack] },
      {
        state: { ...context.simulationState, currentTick: 11, playerEquipment: { weapon: 11889 } },
        events: [{ type: 'hit_applied', eventId: 3, tick: 11, targetId: 'player' }],
      },
      { state: { ...context.simulationState, currentTick: 12, playerEquipment: { weapon: 20997 } }, events: [] },
    ];
    const overrides = { simulationState: frames[2].state, events: [], replayHistory: { frames, throughFrameIndex: 2 } };
    draw(7350, overrides);
    expect(controller.getFrameState()).toEqual({ seqId: 440, currentFrameIndex: 2 });
    lookup.mockClear();
    draw(6910, { ...overrides, simulationState: frames[1].state, replayHistory: { frames, throughFrameIndex: 1 } });
    expect(controller.getFrameState()).toEqual({ seqId: 440, currentFrameIndex: 1 });
    expect(controller['primaryAnimFrameTick']).toBe(15);
    expect(controller['primaryAnimTickAccumulatorMs']).toBeCloseTo(10);
    expect(lookup.mock.calls.every(([id]) => id === PLAYER_EAT_SEQ_ID)).toBe(true);
    expect(engine.play).not.toHaveBeenCalled();
  });

  it('uses a later replay animation candidate when the preferred sequence is unavailable', () => {
    const { controller, lookup, system, type } = installPlayer();
    const attack: GameEvent = {
      type: 'attack_started',
      eventId: 2,
      tick: 10,
      sourceId: 'player',
      targetId: 'npc',
      weaponId: 11889,
      attackKind: 'melee_slash',
      style: 'melee',
    };
    const sequenceIds = playerAttackSequenceIds({ kind: 'weapon', weaponId: 11889, attackKind: 'melee_slash' });
    const preferredId = sequenceIds[0];
    const fallbackId = sequenceIds
      .slice(1)
      .find(
        (id) =>
          id !== preferredId && !type(id).isSkeletalSeq() && system.createSequenceFromSeqType(type(id)) !== undefined,
      );
    if (preferredId === undefined || fallbackId === undefined) expect.fail('Missing weapon animation candidates');
    lookup.mockImplementation((id) => (id === preferredId ? undefined : type(id)));
    const frames = [{ state: context.simulationState, events: [attack] }];

    draw(6810, { events: [], replayHistory: { frames, throughFrameIndex: 0 } });

    expect(controller.getFrameState()).toEqual(expect.objectContaining({ seqId: fallbackId }));
  });

  it('continues to later replay animation cues after an unavailable sequence', () => {
    const { controller, lookup, type } = installPlayer();
    const frames: ReplayDisplayFrame[] = [
      {
        state: context.simulationState,
        events: [{ type: 'spell_self_cast', eventId: 2, tick: 10, animationId: 9999, spotAnimId: -1 }],
      },
      {
        state: { ...context.simulationState, currentTick: 11 },
        events: [{ type: 'item_consumed', eventId: 3, tick: 11 }],
      },
    ];
    lookup.mockImplementation((id) => (id === 9999 ? undefined : type(id)));

    draw(7410, {
      simulationState: frames[1].state,
      events: [],
      replayHistory: { frames, throughFrameIndex: 1 },
    });

    expect(controller.getFrameState()).toEqual(expect.objectContaining({ seqId: PLAYER_EAT_SEQ_ID }));
  });

  it.each(['consume', 'block', 'cast'] as const)('restores %s from its owning historical frame', (kind) => {
    const { controller } = installPlayer();
    const cue: GameEvent =
      kind === 'consume'
        ? { type: 'item_consumed', eventId: 2, tick: 10 }
        : kind === 'block'
          ? { type: 'hit_applied', eventId: 2, tick: 10, targetId: 'player' }
          : { type: 'spell_self_cast', eventId: 2, tick: 10, animationId: 1234, spotAnimId: -1 };
    const equipment = { weapon: 11889, shield: 22322 };
    const frames = [{ state: { ...context.simulationState, playerEquipment: equipment }, events: [cue] }];
    draw(6810, { events: [], replayHistory: { frames, throughFrameIndex: 0 } });
    const seqId =
      kind === 'consume'
        ? PLAYER_EAT_SEQ_ID
        : kind === 'block'
          ? getPlayerBlockAnimations(equipment.weapon, equipment.shield)[0]
          : 1234;
    expect(controller.getFrameState()).toEqual({ seqId, currentFrameIndex: 1 });
    expect(controller.getConsumeAnimSnapshot() !== null).toBe(kind === 'consume');
  });

  it('retries held player metadata silently at the original fractional phase and invalidates a cache identity', () => {
    scene.dispose();
    const yama = yamaScene();
    scene = yama;
    const { controller, lookup, type, types } = installPlayer(yama);
    const tracker = new FrameSoundTracker(engine);
    const silent = vi.spyOn(tracker, 'silentSync');
    const sounded = vi.spyOn(tracker, 'update');
    yama.setFrameSoundTracker(tracker);
    const frames = [
      { state: context.simulationState, events: [{ type: 'item_consumed', eventId: 2, tick: 10 } satisfies GameEvent] },
    ];
    const overrides = {
      events: [],
      replayHistory: { frames, throughFrameIndex: 0 },
      timeline: { timelineKey: 'replay', paused: false, timeMs: 6910 },
    };
    lookup.mockImplementation(() => undefined);
    draw(6910, overrides);
    silent.mockClear();
    sounded.mockClear();
    lookup.mockImplementation(type);
    draw(6910, overrides);
    expect(controller.getFrameState()).toEqual({ seqId: PLAYER_EAT_SEQ_ID, currentFrameIndex: 1 });
    expect(controller['primaryAnimTickAccumulatorMs']).toBeCloseTo(10);
    expect(silent).toHaveBeenCalledOnce();
    expect(sounded).not.toHaveBeenCalled();
    draw(6920, { ...overrides, timeline: { ...overrides.timeline, timeMs: 6920 } });
    expect(controller['primaryAnimFrameTick']).toBe(16);
    expect(sounded).toHaveBeenCalledOnce();
    types.clear();
    type(PLAYER_EAT_SEQ_ID).frameLengths = [10, 10, 100, 10];
    draw(6920, { ...overrides, timeline: { ...overrides.timeline, timeMs: 6920 } });
    expect(controller.getFrameState()).toEqual({ seqId: PLAYER_EAT_SEQ_ID, currentFrameIndex: 2 });
    expect(engine.play).not.toHaveBeenCalled();
  });

  it('changes player accepted state on same-tick history replacement without replaying a queued cue', () => {
    const { controller } = installPlayer();
    const frames = [
      { state: context.simulationState, events: [{ type: 'item_consumed', eventId: 2, tick: 10 } satisfies GameEvent] },
    ];
    draw(6600, { events: [], replayHistory: { frames, throughFrameIndex: 0 } });
    draw(6600, {
      events: [],
      replayHistory: { frames: [{ state: context.simulationState, events: [] }], throughFrameIndex: 0 },
    });
    expect(controller.getConsumeAnimSnapshot()).toBeNull();
    expect(controller.getFrameState()?.seqId).toBe(808);
    expect(controller['signalQueue']).toHaveLength(0);
  });

  it('restores the delayed Yama body and melee secondary through the normal build hook with silent seek/resume', () => {
    scene.dispose();
    const yama = yamaScene();
    scene = yama;
    const state = new SimulationEngine({ encounter: new YamaEncounter(), combatSeed: 1 }).getState();
    const snapshot = state.encounter;
    if (!isYamaSnapshot(snapshot)) expect.fail('Missing Yama snapshot');
    const manager = yama['npcInstanceManager'];
    seed(manager, { actorId: 'primary-npc', npcTypeId: 1, position: [29, 28], size: 5, facing: 0, rotationSpeed: 32 });
    const { type } = installPlayer(yama);
    const clip = (id: number): FrameClipRef => ({
      kind: 'frame',
      id: String(id),
      seqId: id,
      seqType: type(id),
      frameIds: [id * 10, id * 10 + 1, id * 10 + 2],
      frameLengths: [20, 20, 20],
    });
    const animationSet = { idle: clip(100), attack: clip(101), attackClips: { secondary: clip(102) } };
    const instance = manager['instanceRegistry'].get('primary-npc');
    const typeData = manager['typeRegistry'].get(1);
    if (!instance || !typeData) expect.fail('Missing seeded Yama');
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
    instance.animController = controller;
    typeData.animationSet = animationSet;
    const tracker = new FrameSoundTracker(engine);
    const silent = vi.spyOn(tracker, 'silentSync');
    const sounded = vi.spyOn(tracker, 'update');
    yama.setFrameSoundTracker(tracker);
    const frames: ReplayDisplayFrame[] = [
      {
        state: {
          ...context.simulationState,
          encounter: { ...snapshot, state: { ...snapshot.state, lastAttackTick: 10, lastAttackKind: 'magic_fire' } },
        },
        events: [],
      },
      {
        state: {
          ...context.simulationState,
          currentTick: 15,
          encounter: { ...snapshot, state: { ...snapshot.state, lastAttackTick: 15, lastAttackKind: 'melee_crush' } },
        },
        events: [],
      },
    ];
    const at = (cycle: number, throughFrameIndex = 0) =>
      draw(cycle * 20, {
        events: [],
        replayHistory: { frames, throughFrameIndex },
        simulationState: frames[throughFrameIndex].state,
        timeline: { timelineKey: 'replay', paused: false, timeMs: cycle * 20 },
      });
    at(355);
    expect(controller.getFrameState()).toMatchObject({ seqId: 101, currentFrameIndex: 1 });
    at(329.5);
    expect(controller.getFrameState()?.seqId).toBe(100);
    silent.mockClear();
    sounded.mockClear();
    at(330);
    expect(controller.getFrameState()).toMatchObject({ seqId: 101, currentFrameIndex: 0 });
    expect(sounded).toHaveBeenCalledOnce();
    at(475, 1);
    expect(controller.getFrameState()).toMatchObject({ seqId: 102, currentFrameIndex: 1 });
    expect(silent).toHaveBeenCalledOnce();
    expect(engine.play).not.toHaveBeenCalled();
  });

  /**
   * A Yama scene with one 2x2 npc of type 14179 replayed from `frames`; `at(cycle)` draws the frame
   * whose tick the cycle falls in at that displayed cycle, so the NPC clock moves as far as playback
   * does: one cycle (20 ms) per consecutive call.
   */
  function flareReplayScene(
    buildAnimations: (clip: (id: string, seqId: number, frameLengths: number[]) => FrameClipRef) => NpcAnimationSet,
    frames: ReplayDisplayFrame[],
  ) {
    scene.dispose();
    const yama = yamaScene();
    scene = yama;
    yama.setFrameSoundTracker(new FrameSoundTracker(engine));
    yama.setEncounterRenderConfig({
      primaryNpc: { actorId: 'boss', npcTypeId: 1, basePosition: [0, 0], size: 1, deathSeqId: -1 },
    });
    const manager = yama['npcInstanceManager'];
    manager['animSystem'] = new AnimationSystem();
    const clip = (id: string, seqId: number, frameLengths: number[]): FrameClipRef => {
      const type = new SeqType(seqId, {
        name: 'test',
        game: 'oldschool',
        environment: 'test',
        revision: 0,
        timestamp: '',
        size: 0,
      });
      type.frameIds = frameLengths.map((_, index) => seqId * 10 + index);
      type.frameLengths = frameLengths;
      return { kind: 'frame', id, seqId, seqType: type, frameIds: type.frameIds, frameLengths };
    };
    const model = new ModelData();
    model.verticesCount = 3;
    model.verticesX = new Int32Array([-64, 64, 0]);
    model.verticesY = new Int32Array([-47, 145, 0]);
    model.verticesZ = new Int32Array([0, 0, 64]);
    registerType(manager, 1, 1, 32);
    registerType(manager, 14179, 2, 32);
    const flareType = manager['typeRegistry'].get(14179);
    if (!flareType?.modelData) expect.fail('Missing flare type fixture');
    flareType.modelData = { ...flareType.modelData, mergedModel: model };
    flareType.restVerticesX = new Int32Array(model.verticesX);
    flareType.restVerticesY = new Int32Array(model.verticesY);
    flareType.restVerticesZ = new Int32Array(model.verticesZ);
    flareType.animationSet = buildAnimations(clip);
    const at = (cycle: number) => {
      const tick = Math.floor(cycle / 30);
      const throughFrameIndex = frames.reduce(
        (latest, frame, index) => (frame.state.currentTick <= tick ? index : latest),
        0,
      );
      draw(cycle * 20, {
        events: [],
        simulationState: { ...frames[throughFrameIndex].state, currentTick: tick },
        replayHistory: { frames, throughFrameIndex },
        timeline: { timelineKey: 'replay', paused: false, timeMs: cycle * 20 },
      });
      const instance = manager['instanceRegistry'].get('flare') ?? manager['dyingInstances'].get('flare')?.instance;
      return instance?.animController?.getFrameState();
    };
    const plays = (soundId: number) => vi.mocked(engine.play).mock.calls.filter(([id]) => id === soundId).length;
    return { manager, flareType, at, plays };
  }

  const flareState = (tick: number, overrides: Partial<NpcState> = {}): ReplayDisplayFrame => ({
    state: {
      ...context.simulationState,
      currentTick: tick,
      npcs: [
        {
          id: 'flare',
          npcTypeId: 14179,
          archetypeId: 'test',
          role: 'minion',
          alive: true,
          position: [10, 10],
          previousPosition: [10, 10],
          facingAngle: 0,
          size: 2,
          hp: 1,
          maxHp: 1,
          spawnTick: 10,
          history: new Map(),
          ...overrides,
        },
      ],
    },
    events: [],
  });

  const withSound = (clipRef: FrameClipRef, sounds: Array<[frame: number, soundId: number]>) => {
    clipRef.seqType.frameSounds = new Map(
      sounds.map(([frame, soundId]) => [frame, [new SeqSoundEffect(soundId, 1, 0, 0)]]),
    );
    return clipRef;
  };

  it('plays an npc spawn clip from its spawn tick and fires its frame sound only when playback crosses it', () => {
    const { at, plays } = flareReplayScene(
      (clip) => ({
        idle: clip('idle', 12133, [4, 4]),
        spawn: withSound(clip('spawn', 12135, [2, 2, 2, 2]), [[2, 10253]]),
      }),
      [flareState(10)],
    );

    expect(at(300)).toMatchObject({ seqId: 12135, currentFrameIndex: 0 });
    for (let cycle = 301; cycle <= 310; cycle++) at(cycle);
    expect(at(311)?.seqId).toBe(12133);
    expect(plays(10253)).toBe(1);

    // Seeking back onto the sound frame lands on the same phase silently, and nothing replays it.
    expect(at(305)).toMatchObject({ seqId: 12135, currentFrameIndex: 2 });
    for (let cycle = 306; cycle <= 310; cycle++) at(cycle);
    expect(plays(10253)).toBe(1);

    // Seeking back before it and playing forward crosses it again, as the client would.
    expect(at(303)).toMatchObject({ seqId: 12135, currentFrameIndex: 1 });
    expect(plays(10253)).toBe(1);
    at(304);
    expect(plays(10253)).toBe(2);
  });

  describe('npc death clips selected by death cause', () => {
    // Explode: 30 cycles, sounds on frames 1 and 2 (cycles 10, 20); retained 2 ticks. Death: 90
    // cycles, sound on frame 1 (cycle 30); retained for its own length, 3 ticks.
    const animations = (clip: (id: string, seqId: number, frameLengths: number[]) => FrameClipRef) => ({
      idle: clip('idle', 12133, [4, 4]),
      death: withSound(clip('death', 12134, [30, 30, 30]), [[1, 10239]]),
      deathClips: {
        detonated: withSound(clip('death:detonated', 12136, [10, 10, 10]), [
          [1, 10249],
          [2, 10217],
        ]),
      },
    });
    const DEATH_TICK = 11;
    const DEATH_CYCLE = DEATH_TICK * 30;

    function deathScene(deathCause?: string) {
      const scene = flareReplayScene(animations, [
        flareState(10),
        flareState(DEATH_TICK, { alive: false, despawnTick: DEATH_TICK, ...(deathCause ? { deathCause } : {}) }),
      ]);
      scene.flareType.deathClipDurationsMs = { detonated: 2 * 600 };
      return scene;
    }

    it('plays the explode clip for a detonation, sounds each frame once, and removes it 2 ticks later', () => {
      const { at, plays } = deathScene('detonated');
      for (let cycle = 320; cycle < DEATH_CYCLE; cycle++) at(cycle);

      expect(at(DEATH_CYCLE)).toMatchObject({ seqId: 12136, currentFrameIndex: 0 });
      for (let cycle = DEATH_CYCLE + 1; cycle <= DEATH_CYCLE + 40; cycle++) at(cycle);
      expect([plays(10249), plays(10217), plays(10239)]).toEqual([1, 1, 0]);

      // A seek past both sound frames rebuilds the corpse at its age, silently.
      expect(at(DEATH_CYCLE + 25)).toMatchObject({ seqId: 12136, currentFrameIndex: 2 });
      for (let cycle = DEATH_CYCLE + 26; cycle <= DEATH_CYCLE + 50; cycle++) at(cycle);
      expect([plays(10249), plays(10217)]).toEqual([1, 1]);

      // Back between the two: only the later frame is crossed again.
      expect(at(DEATH_CYCLE + 15)).toMatchObject({ seqId: 12136, currentFrameIndex: 1 });
      for (let cycle = DEATH_CYCLE + 16; cycle <= DEATH_CYCLE + 57; cycle++) at(cycle);
      expect([plays(10249), plays(10217)]).toEqual([1, 2]);
      // The corpse timer also takes the arriving frame's delta, so it clears within a frame of +60.
      expect(at(DEATH_CYCLE + 58)?.seqId).toBe(12136);
      expect(at(DEATH_CYCLE + 60)).toBeUndefined();
    });

    it('plays the default death clip for a kill and removes it after the clip, 3 ticks later', () => {
      const { at, plays } = deathScene();
      for (let cycle = 320; cycle < DEATH_CYCLE; cycle++) at(cycle);

      expect(at(DEATH_CYCLE)).toMatchObject({ seqId: 12134, currentFrameIndex: 0 });
      for (let cycle = DEATH_CYCLE + 1; cycle <= DEATH_CYCLE + 87; cycle++) at(cycle);
      expect([plays(10239), plays(10249), plays(10217)]).toEqual([1, 0, 0]);
      expect(at(DEATH_CYCLE + 88)?.seqId).toBe(12134);
      expect(at(DEATH_CYCLE + 90)).toBeUndefined();
    });
  });

  it('restores an earlier player graphic when first displaying a replay destination', () => {
    const graphic: GameEvent = { type: 'player_graphic_applied', eventId: 2, tick: 10, spotAnimId: 123 };
    const frames = [
      { state: { ...context.simulationState, currentTick: 10 }, events: [graphic] },
      { state: { ...context.simulationState, currentTick: 12 }, events: [] },
    ];

    draw(7200, { events: [], replayHistory: { frames, throughFrameIndex: 1 } });

    expect(scene['playerGraphicController']['activeGraphic']).toMatchObject({ spotAnimId: 123, startTime: 10 });
    expect(engine.play).not.toHaveBeenCalled();
  });

  it('replaces generic effects when history changes at the same displayed tick', () => {
    const frames = [
      {
        state: context.simulationState,
        events: [{ type: 'player_graphic_applied', eventId: 2, tick: 10, spotAnimId: 123 } satisfies GameEvent],
      },
    ];
    draw(6000, { events: [], replayHistory: { frames, throughFrameIndex: 0 } });

    draw(6000, {
      events: [],
      replayHistory: { frames: [{ state: context.simulationState, events: [] }], throughFrameIndex: 0 },
    });

    expect(scene['playerGraphicController']['activeGraphic']).toBeNull();
  });

  it('restores expired metadata when seeking backward inside the same simulation tick', () => {
    const renderer = scene['spotAnimRenderer'];
    renderer['meshCache'].set(123, { static: [], frames: [], frameLengths: [10], frameStep: -1, heightOffset: 0 });
    const frames = [
      {
        state: context.simulationState,
        events: [{ type: 'player_graphic_applied', eventId: 2, tick: 10, spotAnimId: 123 } satisfies GameEvent],
      },
    ];
    const overrides = { events: [], replayHistory: { frames, throughFrameIndex: 0 } };
    draw(6400, overrides);

    draw(6100, overrides);

    expect(scene['playerGraphicController']['activeGraphic']).toMatchObject({ spotAnimId: 123, startTime: 10 });
    expect(scene['lastDiscontinuityReason']).toBe('rewind');
  });

  it('keeps transient state when pausing and resuming the same destination', () => {
    const frames = [{ state: context.simulationState, events: [] }];
    draw(6000, { events: [], replayHistory: { frames, throughFrameIndex: 0 } });
    const reset = vi.spyOn(scene['projectileController'], 'dispose');

    for (const paused of [true, false])
      draw(6000, {
        events: [],
        replayHistory: { frames, throughFrameIndex: 0 },
        timeline: { timelineKey: 'replay', paused },
      });

    expect(reset).not.toHaveBeenCalled();
  });

  it('uses raw effect time to expire a graphic after the final pose stops advancing', () => {
    scene['spotAnimRenderer']['meshCache'].set(123, {
      static: [],
      frames: [],
      frameLengths: [90],
      frameStep: -1,
      heightOffset: 0,
    });
    const frames = [
      {
        state: context.simulationState,
        events: [{ type: 'player_graphic_applied', eventId: 2, tick: 10, spotAnimId: 123 } satisfies GameEvent],
      },
    ];
    draw(6000, { events: [], replayHistory: { frames, throughFrameIndex: 0 } });

    draw(6600, {
      simulationState: context.simulationState,
      events: [],
      replayHistory: { frames, throughFrameIndex: 0 },
      timeline: { timelineKey: 'replay', paused: false, timeMs: 7800 },
    });

    expect(scene['playerGraphicController']['activeGraphic']).toBeNull();
  });

  it('materializes a cache-ready Yama cast silently at its original phase on a held destination', () => {
    scene.dispose();
    const yama = new YamaSceneCompositor();
    scene = yama;
    const tracker = new FrameSoundTracker(engine);
    const silent = vi.spyOn(tracker, 'silentSync');
    const sounded = vi.spyOn(tracker, 'update');
    yama.setFrameSoundTracker(tracker);
    const frames = [
      {
        state: context.simulationState,
        events: [
          {
            type: 'attack_started',
            eventId: 2,
            tick: 10,
            sourceId: 'yama',
            targetId: 'player',
            style: 'magic',
            attackKind: 'magic_fire',
          } satisfies GameEvent,
        ],
      },
      { state: { ...context.simulationState, currentTick: 12 }, events: [] },
    ];
    const overrides = { events: [], replayHistory: { frames, throughFrameIndex: 1 } };
    draw(7200, overrides);
    silent.mockClear();
    sounded.mockClear();
    yama['spotAnimRenderer']['meshCache'].set(SpotAnimID.VFX_NPC_YAMA_MAGIC_FIRE_SPOTANIM01, {
      static: [],
      frames: [],
      frameLengths: [30, 30, 30],
      frameStep: -1,
      heightOffset: 0,
    });

    draw(7200, overrides);

    expect(yama['attackController']['activeNpcCastEffect']).toMatchObject({ startCycle: 330 });
    expect(silent).toHaveBeenCalledOnce();
    expect(sounded).not.toHaveBeenCalled();
    expect(engine.play).not.toHaveBeenCalled();
  });

  it('restores Yama graphics and charging flare bars from older events and destination snapshots', () => {
    scene.dispose();
    const yama = new YamaSceneCompositor();
    scene = yama;
    const state = { ...context.simulationState, currentTick: 12 };
    state.npcs = [
      {
        id: 'vf-1',
        npcTypeId: 1,
        archetypeId: 'voidflare',
        role: 'minion',
        alive: true,
        position: [3, 4],
        previousPosition: [3, 4],
        facingAngle: 0,
        size: 2,
        hp: 20,
        maxHp: 20,
        spawnTick: 10,
        despawnTick: 16,
        history: new Map(),
      },
    ];
    const frames = [
      {
        state: context.simulationState,
        events: [
          {
            type: 'attack_started',
            eventId: 2,
            tick: 10,
            sourceId: 'yama',
            targetId: 'player',
            style: 'magic',
            attackKind: 'magic_fire',
          } satisfies GameEvent,
        ],
      },
      { state, events: [] },
    ];

    const queue = yama.build(
      {
        ...context,
        simulationState: state,
        interpolatedTick: 12,
        events: [],
        replayHistory: { frames, throughFrameIndex: 1 },
      },
      projection,
      { width: 800, height: 600, dpr: 1 },
    );

    expect(yama['attackController']['activePlayerImpactEffect']).toMatchObject({ startCycle: 300 });
    // The charging flare is drawn straight from the destination snapshot: its bar background and fill.
    expect(queue.commands.filter((command) => command.kind === 'poly2d' && command.zIndex === 36)).toHaveLength(2);
  });

  it('keeps future replay cues out of the audio engine when an event first renders', () => {
    draw(6000);

    expect(engine.play).not.toHaveBeenCalled();
  });

  it('uses unclamped replay time for an audio cue beyond the final clamped pose', () => {
    scene.setEventAudioPlayer(
      new EventAudioPlayer(engine, {
        name: 'tail',
        rules: { actor_died: { resolve: { id: 10313, delayCycles: 60 } } },
      }),
    );
    draw(6000);

    draw(6600, {
      simulationState: context.simulationState,
      events: [],
      timeline: { timelineKey: 'replay', paused: false, timeMs: 7200 },
    });

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(10313, { channel: 'sfx', volume: 1 }, 'event:actor_died');
  });

  it.each([0.5, 1, 2])('drains due cues without new events using game-tick time at %sx', (speedMultiplier) => {
    draw(6000, { speedMultiplier });

    draw(6000 + (420 / speedMultiplier) * speedMultiplier, { events: [], speedMultiplier });

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(10313, { channel: 'sfx', volume: 1 }, 'event:actor_died');
  });

  it('retains a pending cue across paused renders and the same-frame resume', () => {
    draw(6000);
    engine.stopAll();
    draw(6100, { timeline: { timelineKey: 'replay', paused: true } });
    draw(6100, { timeline: { timelineKey: 'replay', paused: false } });

    draw(6420);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(10313, { channel: 'sfx', volume: 1 }, 'event:actor_died');
  });

  it('holds due cues while paused even if a final clock update reached their boundary', () => {
    draw(6000);

    draw(6420, { timeline: { timelineKey: 'replay', paused: true } });

    expect(engine.play).not.toHaveBeenCalled();
  });

  it.each([
    { reason: 'rewind', nextTimeMs: 5400, timelineKey: 'replay' },
    { reason: 'forward jump', nextTimeMs: 7200, timelineKey: 'replay' },
    { reason: 'timeline replacement', nextTimeMs: 6000, timelineKey: 'replacement' },
  ])('cancels pending cues on $reason before publishing the new clock', ({ nextTimeMs, timelineKey }) => {
    draw(6000);
    draw(nextTimeMs, { events: [], timeline: { timelineKey, paused: false } });

    draw(Math.max(nextTimeMs, 6420), { events: [], timeline: { timelineKey, paused: false } });

    expect(engine.play).not.toHaveBeenCalled();
  });

  it('cancels pending cues when scene reset happens without a tick change', () => {
    draw(6000);
    scene.resetIntroState();

    draw(6420, { events: [] });

    expect(engine.play).not.toHaveBeenCalled();
  });

  it('retains the existing live wall-delay path when replay history is absent', () => {
    const { replayHistory: _history, ...liveContext } = context;
    context = liveContext;

    draw(6000);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(
      10313,
      { channel: 'sfx', volume: 1, delayMs: 420 },
      'event:actor_died',
    );
  });
});
