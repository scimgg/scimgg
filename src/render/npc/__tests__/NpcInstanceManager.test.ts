import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '../../../audio/AudioEngine';
import { type ActorFrameState, FrameSoundTracker } from '../../../audio/FrameSoundTracker';
import { CacheSystem } from '../../../rs/cache/CacheSystem';
import { Bzip2 } from '../../../rs/compression/Bzip2';
import { NpcType } from '../../../rs/config/npctype/NpcType';
import { ArchiveNpcTypeLoader, type NpcTypeLoader } from '../../../rs/config/npctype/NpcTypeLoader';
import { SeqSoundEffect, SeqType } from '../../../rs/config/seqtype/SeqType';
import { ModelData } from '../../../rs/model/ModelData';
import { IndexModelLoader } from '../../../rs/model/ModelLoader';
import { modelDataToMesh, type NpcMeshData, type NpcModelData, NpcModelLoader } from '../../../rs/model/NpcModelLoader';
import { readCacheZipFiles } from '../../../test/helpers/cacheZipFiles';
import {
  findProjectCacheZip,
  REAL_CACHE_TEST_TIMEOUT_MS,
  skipWithoutRealCache,
} from '../../../test/helpers/real-cache';
import { type NpcSnapshot, OSRS_TICK_MS } from '../../../types/simulation';
import { AnimationSystem } from '../../backends/picogl/AnimationSystem';
import { createQueue, type NpcMesh3DCommand } from '../../core/commands';
import { NpcVisualTracker } from '../../core/interpolation';
import { sharedModelTextureIndex } from '../../core/modelTextures';
import { ReplayDeferredPrimaryIndex } from '../../core/replayDeferredPrimaryIndex';
import { ReplayPrimaryIndex } from '../../core/replayPrimaryIndex';
import { type AnimClipRef, CLIENT_TICK_MS, type FrameClipRef } from '../animationTypes';
import { NpcAnimationController } from '../NpcAnimationController';
import {
  NpcInstanceManager,
  type NpcTypeLoadConfig,
  npcModelLiftFromAnimationHeightOffset,
  PRIMARY_NPC_ACTOR_ID,
  usesBoundingBoxClickboxForNpcSize,
} from '../NpcInstanceManager';
import {
  appliedAngle,
  bearing,
  CLIENT_CYCLE_MS,
  deleteInstance,
  expectedSmoothed,
  makeSnapshot,
  mutableInstance,
  PRIMARY_BASE_POS,
  PRIMARY_SIZE,
  PRIMARY_TYPE_ID,
  registerType,
  seed,
  setPrimaryConfig,
  trackerFor,
} from './npcFacingTestHarness';
import { reconstructLiveAnimation } from './reconstructLiveAnimation';

function presentationClip(id: string, seqId: number, frameLengths = [2, 2, 2, 2]): FrameClipRef {
  const seqType = new SeqType(seqId, {
    name: 'test',
    game: 'oldschool',
    environment: 'test',
    revision: 0,
    timestamp: '1970-01-01T00:00:00.000Z',
    size: 0,
  });
  const frameIds = frameLengths.map((_, index) => seqId + index);
  seqType.frameIds = frameIds;
  seqType.frameLengths = frameLengths;
  return { kind: 'frame', id, seqId, seqType, frameIds, frameLengths };
}

describe('NpcInstanceManager presentation cue identity', () => {
  const actorId = 'jad';
  type Trigger = Parameters<NpcInstanceManager['updateAnimations']>[2][number];
  const cue = (clipId: string, overrides: Partial<Trigger> = {}): Trigger => ({
    actorId,
    trigger: 'attack',
    clipId,
    tick: 10,
    ...overrides,
  });

  function setup() {
    const manager = new NpcInstanceManager();
    const idle = presentationClip('idle', 0);
    const range = presentationClip('range', 7593);
    range.seqType.forcedPriority = 10;
    const defend = presentationClip('defend', 7591);
    defend.seqType.forcedPriority = 4;
    const animationSet = { idle, attack: range, attackClips: { range, defend } };
    const modelAdapter = {
      resetPose() {},
      applyFrame() {},
      applyFrameInterleaved() {},
      applySkeletal() {},
      resize() {},
      commitPose() {},
    };
    const controller = new NpcAnimationController({ animationSet, modelAdapter });
    manager['typeRegistry'].set(7700, { ...makeTypeRegistryEntry(7700, 1, 32), animationSet });
    const instance = { ...makeInstance(actorId, 7700, new Float32Array(16)), animController: controller, modelAdapter };
    return { manager, controller, instance };
  }

  it('clears a restored primary when replacement animation metadata no longer resolves its cue', () => {
    const { manager, controller, instance } = setup();
    manager['instanceRegistry'].set(actorId, instance);
    const timeline = new ReplayDeferredPrimaryIndex<AnimClipRef>();
    timeline.append(0, 10, [{ cycle: 300, clipId: 'range' }]);
    const destination = { cycle: 303, throughFrameIndex: 0, spawnTick: 10 };
    manager.restoreDeferredReplayAnimation(actorId, timeline, destination);
    manager.updateAnimations(0, 1, []);
    expect(controller.getFrameState()?.seqId).toBe(7593);
    const type = manager['typeRegistry'].get(7700);
    if (!type?.animationSet) expect.fail('Missing animation fixture');
    type.animationSet = { ...type.animationSet, attackClips: {} };
    manager.restoreDeferredReplayAnimation(actorId, timeline, destination);
    manager.updateAnimations(0, 1, []);
    expect(controller.getFrameState()?.seqId).toBe(0);
  });

  it.each([
    0, 7, 70,
  ])('matches canonical base phase without spawn stepping when the first cue is delayed %s cycles', (delay) => {
    const reference = setup();
    const sought = setup();
    for (const fixture of [reference, sought]) {
      fixture.manager['instanceRegistry'].set(actorId, fixture.instance);
      fixture.manager['movementByActorId'].set(actorId, true);
      const set = fixture.manager['typeRegistry'].get(7700)?.animationSet;
      if (!set) expect.fail('Missing animation fixture');
      set.walk = presentationClip('walk', 100, [3, 5, 7]);
    }
    const destination = 373.5;
    reconstructLiveAnimation(reference.manager, actorId, {
      spawnTick: 10,
      throughTick: destination / 30,
      triggers: [{ ...cue('range'), tick: (300 + delay) / 30 }],
    });
    const timeline = new ReplayDeferredPrimaryIndex<AnimClipRef>();
    timeline.append(0, 10, [{ cycle: 300 + delay, clipId: 'range' }]);
    const update = vi.spyOn(sought.controller, 'update');
    const commit = vi.spyOn(sought.instance.modelAdapter, 'commitPose');
    sought.manager.restoreDeferredReplayAnimation(actorId, timeline, {
      cycle: destination,
      throughFrameIndex: 0,
      spawnTick: 10,
    });
    expect(update).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    sought.manager.updateAnimations(0, 1, []);
    expect(sought.controller.getFrameState()).toEqual(reference.instance.animController.getFrameState());
    expect(sought.controller['baseTrack']?.elapsedTicks).toBe(
      reference.instance.animController['baseTrack']?.elapsedTicks,
    );
    expect(sought.controller['tickRemainderMs']).toBeCloseTo(reference.instance.animController['tickRemainderMs']);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('restores an indexed primary after late instance readiness without historical mesh updates or pending retriggers', () => {
    const { manager, controller, instance } = setup();
    const commit = vi.spyOn(instance.modelAdapter, 'commitPose');
    const timeline = new ReplayPrimaryIndex<Trigger, AnimClipRef>([
      { frameIndex: 0, tick: 10, value: cue('range', { delayClientTicks: 30, durationGameTicks: 3 }) },
      { frameIndex: 1, tick: 10, value: cue('defend') },
    ]);
    manager.updateAnimations(0, 1, [cue('defend')]);
    const destination = { cycle: 333.5, throughFrameIndex: 1 };
    expect(manager.restoreReplayPrimary(actorId, timeline, destination)).toBe(false);
    manager['instanceRegistry'].set(actorId, instance);
    expect(manager.restoreReplayPrimary(actorId, timeline, destination)).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    manager.updateAnimations(0, 1, []);
    expect(controller.getFrameState()).toMatchObject({ seqId: 7593, currentFrameIndex: 1 });
    expect(commit).toHaveBeenCalledOnce();
    manager.updateAnimations(10, 1, []);
    expect(controller.getFrameState()).toMatchObject({ seqId: 7593, currentFrameIndex: 2 });
    manager.resetTransientState();
    manager.restoreReplayPrimary(actorId, timeline, { cycle: 315, throughFrameIndex: 1 });
    manager.updateAnimations(0, 1, []);
    expect(controller.getFrameState()?.seqId).toBe(0);
  });

  it.each([false, true])('arbitrates distinct same-cycle clips when split delivery is %s', (split) => {
    const { manager, controller, instance } = setup();
    manager['instanceRegistry'].set(actorId, instance);

    if (split) {
      manager.updateAnimations(0, 1, [cue('defend')]);
      manager.updateAnimations(0, 1, [cue('range')]);
    } else {
      manager.updateAnimations(0, 1, [cue('defend'), cue('range')]);
    }

    expect(controller.getFrameState()?.seqId).toBe(7593);
  });

  it('reconstructs one live actor with arbitration and dedup without aging unrelated presentation', () => {
    const { manager, instance } = setup();
    const unrelated = setup();
    manager['instanceRegistry'].set(actorId, instance);
    manager['instanceRegistry'].set('unrelated', { ...unrelated.instance, actorId: 'unrelated' });
    manager.reconstructDyingInstance(
      makeSnapshot({ id: 'corpse', npcTypeId: 7700, position: [10, 10], size: 1, alive: false }),
      40,
    );
    const unrelatedPose = unrelated.controller.getFrameState();
    manager.updateAnimations(0, 1, [cue('range', { actorId: 'pending' })]);

    reconstructLiveAnimation(manager, actorId, {
      spawnTick: 10,
      throughTick: 10.1,
      triggers: [
        { ...cue('defend'), tick: 10 },
        { ...cue('range'), tick: 10 },
        { ...cue('range'), tick: 10 },
      ],
    });

    expect(instance.animController.getFrameState()).toMatchObject({ seqId: 7593, currentFrameIndex: 1 });
    expect(unrelated.controller.getFrameState()).toEqual(unrelatedPose);
    expect(manager['dyingInstances'].get('corpse')?.deathTimerMs).toBe(40);
    expect(manager['pendingAttackTriggersByActor'].has('pending')).toBe(true);
  });

  it('does not reconstruct a dying actor through the live animation seam', () => {
    const { manager } = setup();
    manager.reconstructDyingInstance(
      makeSnapshot({ id: actorId, npcTypeId: 7700, position: [10, 10], size: 1, alive: false }),
      40,
    );

    reconstructLiveAnimation(manager, actorId, {
      spawnTick: 0,
      throughTick: 100,
      triggers: [{ ...cue('range'), tick: 10 }],
    });

    expect(manager['dyingInstances'].get(actorId)?.deathTimerMs).toBe(40);
    expect(manager['pendingAttackTriggersByActor'].has(actorId)).toBe(false);
  });

  it('reconstructs the same local age when the same actor is sought again', () => {
    const { manager, instance } = setup();
    manager['instanceRegistry'].set(actorId, instance);
    const reconstruction = { spawnTick: 10, throughTick: 10.1, triggers: [{ ...cue('range'), tick: 10 }] };
    reconstructLiveAnimation(manager, actorId, reconstruction);

    reconstructLiveAnimation(manager, actorId, reconstruction);

    expect(instance.animController?.['baseTrack']?.elapsedTicks).toBe(3);
    expect(instance.animController?.getFrameState()).toMatchObject({ seqId: 7593, currentFrameIndex: 1 });
  });

  it('preserves reconstructed signal dedup when normal animation updates resume', () => {
    const { manager, instance } = setup();
    manager['instanceRegistry'].set(actorId, instance);
    reconstructLiveAnimation(manager, actorId, {
      spawnTick: 10,
      throughTick: 10.1,
      triggers: [{ ...cue('range'), tick: 10 }],
    });

    manager.updateAnimations(0, 1, [cue('range')]);

    expect(instance.animController.getFrameState()).toMatchObject({ seqId: 7593, currentFrameIndex: 1 });
  });

  it.each([
    false,
    true,
  ])('retains same-cycle pending contenders when controller-only loading is %s', (controllerOnly) => {
    const { manager, controller, instance } = setup();
    if (controllerOnly) manager['instanceRegistry'].set(actorId, { ...instance, animController: null });
    manager.updateAnimations(0, 1, [cue('range')]);
    manager.updateAnimations(0, 1, [cue('defend')]);
    manager['instanceRegistry'].set(actorId, instance);

    manager.updateAnimations(0, 1, []);

    expect(controller.getFrameState()?.seqId).toBe(7593);
  });

  it('merges a pending contender when a distinct cue arrives on the readiness frame', () => {
    const { manager, controller, instance } = setup();
    manager.updateAnimations(0, 1, [cue('range')]);
    manager['instanceRegistry'].set(actorId, instance);

    manager.updateAnimations(0, 1, [cue('defend')]);

    expect(controller.getFrameState()?.seqId).toBe(7593);
  });

  it('does not restart a cue when identical delivery follows another contender', () => {
    const { manager, controller, instance } = setup();
    manager['instanceRegistry'].set(actorId, instance);
    manager.updateAnimations(0, 1, [cue('range'), cue('defend')]);

    manager.updateAnimations(60, 1, [cue('range')]);

    expect(controller.getFrameState()).toMatchObject({ seqId: 7593, currentFrameIndex: 1 });
  });

  it('deduplicates repeated pending delivery and its repeat after flushing', () => {
    const { manager, controller, instance } = setup();
    const triggerAttack = vi.spyOn(controller, 'triggerAttack');
    manager.updateAnimations(0, 1, [cue('range'), cue('defend'), cue('range')]);
    manager.updateAnimations(0, 1, [cue('defend')]);
    expect(manager['pendingAttackTriggersByActor'].get(actorId)).toHaveLength(2);
    manager['instanceRegistry'].set(actorId, instance);

    manager.updateAnimations(0, 1, [cue('range')]);
    manager.updateAnimations(60, 1, [cue('range'), cue('defend')]);

    expect(triggerAttack).toHaveBeenCalledTimes(2);
    expect(controller.getFrameState()).toMatchObject({ seqId: 7593, currentFrameIndex: 1 });
  });

  it.each([{ delayClientTicks: 3 }, { durationGameTicks: 2 }])('arbitrates changed cue timing %j', (timing) => {
    const { manager, controller, instance } = setup();
    const triggerAttack = vi.spyOn(controller, 'triggerAttack');
    manager['instanceRegistry'].set(actorId, instance);
    manager.updateAnimations(0, 1, [cue('range')]);

    manager.updateAnimations(0, 1, [cue('range', timing)]);

    expect(triggerAttack).toHaveBeenCalledTimes(2);
    expect(triggerAttack).toHaveBeenLastCalledWith(
      expect.objectContaining('delayClientTicks' in timing ? { delayClientTicks: 3 } : { durationClientTicks: 60 }),
    );
  });

  it('allows the same cue on a later cycle', () => {
    const { manager, controller, instance } = setup();
    manager['instanceRegistry'].set(actorId, instance);
    manager.updateAnimations(0, 1, [cue('range')]);

    manager.updateAnimations(60, 1, [cue('range', { tick: 10 + 1 / 30 })]);

    expect(controller.getFrameState()).toMatchObject({ seqId: 7593, currentFrameIndex: 0 });
  });

  it('allows identical cues again when the timeline trigger state is reset', () => {
    const { manager, controller, instance } = setup();
    manager['instanceRegistry'].set(actorId, instance);
    manager.updateAnimations(0, 1, [cue('range')]);
    manager.resetAttackTriggerState();

    manager.updateAnimations(60, 1, [cue('range')]);

    expect(controller.getFrameState()).toMatchObject({ seqId: 7593, currentFrameIndex: 0 });
  });

  it('keeps latest-wins loading behavior when cues have no delivery tick', () => {
    const { manager, controller, instance } = setup();
    manager.updateAnimations(0, 1, [cue('range', { tick: undefined })]);
    manager.updateAnimations(0, 1, [cue('defend', { tick: undefined })]);
    manager['instanceRegistry'].set(actorId, instance);

    manager.updateAnimations(0, 1, []);

    expect(controller.getFrameState()?.seqId).toBe(7591);
  });
});

// Coverage for the one-shot NPC attack-trigger load race: a trigger
// (e.g. Yama's per-beat attack animation) emitted on a single tick must not be
// lost when the target NPC's instance + animController are still loading
// asynchronously. It is stashed and flushed once the actor is ready, exactly
// once, latest-wins — mirroring the player-side pendingPlayerAttack handling.
describe('NpcInstanceManager attack-trigger load race', () => {
  type Call = { clip?: unknown; durationClientTicks?: number; delayClientTicks?: number };

  function makeController() {
    const calls: Call[] = [];
    return {
      controller: {
        triggerAttack: (opts: Call = {}) => calls.push(opts),
        update: () => {},
      },
      calls,
    };
  }

  function makeInstance(actorId: string, animController: unknown) {
    return {
      actorId,
      npcTypeId: 123,
      animController,
      lastAttackTriggerTick: -1,
    };
  }

  function trigger(tick: number, extra: Record<string, unknown> = {}) {
    return { actorId: 'primary-npc', trigger: 'attack', tick, ...extra };
  }

  it('stashes an attack trigger when the instance does not exist yet', () => {
    const manager = new NpcInstanceManager();
    // No instance registered — simulates the beat tick landing before loadNpcType.
    manager.updateAnimations(20, 1, [trigger(10)] as any);

    expect((manager as any).pendingAttackTriggersByActor.has('primary-npc')).toBe(true);
  });

  it('flushes the stashed trigger exactly once when the instance becomes ready', () => {
    const manager = new NpcInstanceManager();
    manager.updateAnimations(20, 1, [trigger(10)] as any);

    const { controller, calls } = makeController();
    (manager as any).instanceRegistry.set('primary-npc', makeInstance('primary-npc', controller));

    // Next frame, no new trigger emitted (beat tick passed) — pending must flush.
    manager.updateAnimations(20, 1, []);
    expect(calls).toHaveLength(1);
    expect((manager as any).pendingAttackTriggersByActor.has('primary-npc')).toBe(false);

    // And it must not replay on subsequent frames.
    manager.updateAnimations(20, 1, []);
    expect(calls).toHaveLength(1);
  });

  it('stashes when the instance exists but its animController is null, then flushes', () => {
    const manager = new NpcInstanceManager();
    const instance = makeInstance('primary-npc', null);
    (manager as any).instanceRegistry.set('primary-npc', instance);

    // animController not built yet -> stash, no play.
    manager.updateAnimations(20, 1, [trigger(10)] as any);
    expect((manager as any).pendingAttackTriggersByActor.has('primary-npc')).toBe(true);

    // Controller appears; pending flushes once.
    const { controller, calls } = makeController();
    instance.animController = controller;
    manager.updateAnimations(20, 1, []);
    expect(calls).toHaveLength(1);
    expect((manager as any).pendingAttackTriggersByActor.has('primary-npc')).toBe(false);
  });

  it('latest-wins: a newer pending trigger supersedes an older one while loading', () => {
    const manager = new NpcInstanceManager();
    manager.updateAnimations(20, 1, [trigger(10, { clipId: 'default' })] as any);
    manager.updateAnimations(20, 1, [trigger(14, { clipId: 'secondary' })] as any);

    const pending = manager['pendingAttackTriggersByActor'].get('primary-npc');
    expect(pending).toMatchObject([{ tick: 14, clipId: 'secondary' }]);
  });

  it('an immediate ready trigger supersedes a stale pending one (no double play)', () => {
    const manager = new NpcInstanceManager();
    // Stash an old trigger while not ready.
    manager.updateAnimations(20, 1, [trigger(10)] as any);

    const { controller, calls } = makeController();
    (manager as any).instanceRegistry.set('primary-npc', makeInstance('primary-npc', controller));

    // Same frame the actor is ready AND a fresh trigger arrives: only the fresh
    // one plays, the stale pending is discarded.
    manager.updateAnimations(20, 1, [trigger(20)] as any);
    expect(calls).toHaveLength(1);
    expect((manager as any).pendingAttackTriggersByActor.has('primary-npc')).toBe(false);
  });

  it('does not replay the same tick twice via the dedup guard', () => {
    const manager = new NpcInstanceManager();
    const { controller, calls } = makeController();
    (manager as any).instanceRegistry.set('primary-npc', makeInstance('primary-npc', controller));

    manager.updateAnimations(20, 1, [trigger(30)] as any);
    manager.updateAnimations(20, 1, [trigger(30)] as any);
    expect(calls).toHaveLength(1);
  });

  it('resetAttackTriggerState clears pending and resets the dedup tick', () => {
    const manager = new NpcInstanceManager();
    manager.updateAnimations(20, 1, [trigger(10)] as any);
    const instance = makeInstance('primary-npc', null);
    instance.lastAttackTriggerTick = 10;
    (manager as any).instanceRegistry.set('primary-npc', instance);

    manager.resetAttackTriggerState();

    expect((manager as any).pendingAttackTriggersByActor.size).toBe(0);
    expect(instance.lastAttackTriggerTick).toBe(-1);
  });
});

describe('NpcInstanceManager interpolation endpoints', () => {
  it.each([
    { tick: 10, fraction: 0.5, y: 12.25, moving: true },
    { tick: 11, fraction: 0, y: 12.5, moving: true },
    { tick: 11, fraction: 0.5, y: 12.75, moving: true },
    { tick: 12, fraction: 0, y: 13, moving: false },
  ])('uses snapshot tick $tick for crawl models and movement, independently of animation cycle', ({
    tick,
    fraction,
    y,
    moving,
  }) => {
    const manager = new NpcInstanceManager();
    registerType(manager, 9000, 1, 32);
    const npc: NpcSnapshot = {
      ...makeSnapshot({ id: 'mob', npcTypeId: 9000, position: [10, 13], size: 1 }),
      crawlMovement: { from: [10, 12], to: [10, 13], startTick: 10 },
    };
    manager.syncInstances([npc], fraction, 3000, tick);
    expect(manager.getVisualPosition('mob')).toEqual([10, y]);
    expect(manager['movementByActorId'].get('mob')).toBe(moving);
    const matrix = manager['instanceRegistry'].get('mob')!.currentModelMatrix;
    expect(matrix[12]).toBe(10.5);
    expect(matrix[13]).toBe(y + 0.5);
    // A backwards direct seek samples the same segment with no retained positional history.
    manager.syncInstances([npc], 0, 6000, 10);
    expect(manager.getVisualPosition('mob')).toEqual([10, 12]);
  });

  it.each([
    { fraction: 0, expected: [10, 12] },
    { fraction: 0.5, expected: [11, 13] },
    { fraction: 1, expected: [12, 14] },
    { fraction: undefined, expected: [12, 14] },
  ])('places a moving NPC at $expected with fraction $fraction', ({ fraction, expected }) => {
    const manager = new NpcInstanceManager();
    registerType(manager, 9000, 1, 32);
    const npc = {
      ...makeSnapshot({ id: 'mob', npcTypeId: 9000, position: [12, 14], size: 1 }),
      previousPosition: [10, 12] satisfies [number, number],
    };

    manager.syncInstances([npc], fraction);

    expect(manager.getVisualPosition('mob')).toEqual(expected);
  });

  it.each([0, 0.5, 1, undefined])('keeps a stationary NPC in place with fraction %s', (fraction) => {
    const manager = new NpcInstanceManager();
    registerType(manager, 9000, 1, 32);
    const npc = makeSnapshot({ id: 'mob', npcTypeId: 9000, position: [12, 14], size: 1 });

    manager.syncInstances([npc], fraction);

    expect(manager.getVisualPosition('mob')).toEqual([12, 14]);
  });

  // B:2208 sim tiles: a warband seer runs (24,39) -> (23,40) -> (23,41) and is on the corner at mid-tick.
  it.each([
    { fraction: 0.25, expected: [23.5, 39.5] },
    { fraction: 0.5, expected: [23, 40] },
    { fraction: 0.75, expected: [23, 40.5] },
    { fraction: 1, expected: [23, 41] },
  ])('walks a two-step run through its corner tile at fraction $fraction', ({ fraction, expected }) => {
    const manager = new NpcInstanceManager();
    registerType(manager, 9000, 1, 32);
    const npc = {
      ...makeSnapshot({ id: 'mob', npcTypeId: 9000, position: [23, 41], size: 1 }),
      previousPosition: [24, 39] satisfies [number, number],
      movementPath: [
        [23, 40],
        [23, 41],
      ] satisfies [number, number][],
    };

    manager.syncInstances([npc], fraction);

    expect(manager.getVisualPosition('mob')).toEqual(expected);
  });
});

describe('NpcInstanceManager delayed death animation', () => {
  const actorId = 'warbander';
  const npcTypeId = 9300;
  const dead = { ...makeSnapshot({ id: actorId, npcTypeId, position: [10, 10], size: 1, alive: false }) };
  const delayed = { ...dead, despawnTick: 20, deathAnimationTick: 22 };

  function managerWithLiveNpc(): NpcInstanceManager {
    const manager = new NpcInstanceManager();
    seed(manager, { actorId, npcTypeId, position: [10, 10], size: 1, facing: 0, rotationSpeed: 32 });
    return manager;
  }

  it('keeps the NPC standing until its death animation tick, then plays the death', () => {
    const manager = managerWithLiveNpc();

    manager.syncInstances([delayed], 0, 20 * 30);
    manager.syncInstances([delayed], 0, 22 * 30 - 1);
    expect(manager.getDyingActorIds().size).toBe(0);
    expect(manager.getVisualPosition(actorId)).toEqual([10, 10]);

    manager.syncInstances([delayed], 0, 22 * 30);
    expect(manager.getDyingActorIds()).toEqual(new Set([actorId]));
  });

  it('walks a queued death through its final permitted step before the death animation', () => {
    const manager = managerWithLiveNpc();
    // Killed on tick 20 mid-step from [10, 10] to [11, 10]; it falls at 23 (last step + 3).
    const stepping = {
      ...delayed,
      previousPosition: [10, 10] as [number, number],
      position: [11, 10] as [number, number],
      deathAnimationTick: 23,
    };

    manager.syncInstances([stepping], 0.5, 20 * 30 + 15);

    expect(manager.getDyingActorIds().size).toBe(0);
    expect(manager.getVisualPosition(actorId)).toEqual([10.5, 10]);
  });

  it('starts the death at once without a presentation clock or a delay', () => {
    for (const [snapshot, cycle] of [
      [delayed, undefined],
      [dead, 20 * 30],
    ] as const) {
      const manager = managerWithLiveNpc();
      manager.syncInstances([snapshot], 0, cycle);
      expect(manager.getDyingActorIds()).toEqual(new Set([actorId]));
    }
  });

  it('measures a reconstructed corpse from its death animation tick, not the defeat', () => {
    const manager = new NpcInstanceManager();
    registerType(manager, npcTypeId, 1, 32);

    manager.reconstructDyingInstance(delayed, 2 * OSRS_TICK_MS - 1);
    expect(manager.getDyingActorIds().size).toBe(0);

    manager.reconstructDyingInstance(delayed, 2 * OSRS_TICK_MS);
    expect(manager.getDyingActorIds()).toEqual(new Set([actorId]));
    // The default death lasts one tick, so it is gone a tick after the delayed start.
    manager.reconstructDyingInstance(delayed, 3 * OSRS_TICK_MS);
    expect(manager.getDyingActorIds().size).toBe(0);
  });

  it('takes a corpse back to the standing NPC on a seek back into the delay', () => {
    const manager = managerWithLiveNpc();
    manager.syncInstances([delayed], 0, 22 * 30);
    expect(manager.getDyingActorIds()).toEqual(new Set([actorId]));

    manager.syncInstances([delayed], 0, 21 * 30);

    expect(manager.getDyingActorIds().size).toBe(0);
    expect(manager.getVisualPosition(actorId)).toEqual([10, 10]);
  });
});

describe('NpcInstanceManager clickbox mode', () => {
  it('gives a one-tile NPC the bounding-box clickbox', () => {
    expect(usesBoundingBoxClickboxForNpcSize(1)).toBe(true);
  });

  it('leaves every larger NPC on the per-face clickbox', () => {
    expect(usesBoundingBoxClickboxForNpcSize(3)).toBe(false);
    expect(usesBoundingBoxClickboxForNpcSize(7)).toBe(false);
  });
});

/**
 * Per-actor tracker lifecycle: drop on despawn/death, re-seed on actor-id reuse,
 * corpse freezes at its last rendered facing, timeline reset snaps, dispose
 * clears everything, and a primary death clears the cached angle.
 */
describe('NpcInstanceManager facing lifecycle', () => {
  it('drops a tracker on despawn and re-seeds a reused actor id from its fresh facing', () => {
    const manager = new NpcInstanceManager();
    registerType(manager, 9000, 1, 32);
    // The renderer derives `turn-to-angle` from the snapshot's facing, so an NPC turns
    // by its facing CHANGING between ticks - exactly as the simulation drives it.
    const atZero = makeSnapshot({ id: 'mob', npcTypeId: 9000, position: [10, 10], size: 1, facingAngle: 0 });
    const atNorth = makeSnapshot({ id: 'mob', npcTypeId: 9000, position: [10, 10], size: 1, facingAngle: 1024 });

    manager.syncInstances([atZero]);
    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS); // creates the tracker, seeded at 0
    expect(trackerFor(manager, 'mob')).toBeDefined();

    manager.syncInstances([atNorth]); // facing changes -> the tracker now has somewhere to turn
    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);
    expect(appliedAngle(manager, 'mob')).toBe(expectedSmoothed(0, 1024, 32)); // 0 -> 32

    // Despawn: dropped so a reused id re-seeds from the fresh snapshot facing.
    manager.syncInstances([]);
    expect(trackerFor(manager, 'mob')).toBeUndefined();

    // Reuse the same id: a persisted tracker would step 32 -> 64; a fresh one 0 -> 32.
    manager.syncInstances([atZero]);
    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);
    manager.syncInstances([atNorth]);
    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);
    expect(appliedAngle(manager, 'mob')).toBe(expectedSmoothed(0, 1024, 32));
    expect(appliedAngle(manager, 'mob')).not.toBe(expectedSmoothed(32, 1024, 32));
  });

  it('freezes a corpse at its last rendered facing (dying instances are not advanced)', () => {
    const manager = new NpcInstanceManager();
    registerType(manager, 9100, 1, 32);
    const alive = makeSnapshot({
      id: 'mob',
      npcTypeId: 9100,
      position: [10, 10],
      size: 1,
      intent: { kind: 'turn-to-angle', angle: 1024 },
    });

    manager.syncInstances([alive]);
    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);
    const frozen = Array.from(manager.getModelMatrix('mob') ?? []);
    expect(frozen).toHaveLength(16);

    // Death moves the instance to the dying set; further passes must not rotate it.
    manager.syncInstances([makeSnapshot({ id: 'mob', npcTypeId: 9100, position: [10, 10], size: 1, alive: false })]);
    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);

    expect(Array.from(manager.getModelMatrix('mob') ?? [])).toEqual(frozen);
    expect(trackerFor(manager, 'mob')).toBeUndefined();
  });

  it('snaps every NPC to its resolved target on the frame after resetTransientState (timeline seek)', () => {
    const manager = new NpcInstanceManager();
    seed(manager, {
      actorId: 'mob',
      npcTypeId: 8070,
      position: [5, 5],
      size: 1,
      facing: 0,
      rotationSpeed: 32,
      intent: { kind: 'turn-to-angle', angle: 1024 },
    });
    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);
    expect(appliedAngle(manager, 'mob')).not.toBe(1024);

    manager.resetTransientState();
    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);

    expect(appliedAngle(manager, 'mob')).toBe(1024);
  });

  it('clears all trackers and the cached primary angle on dispose', () => {
    const manager = new NpcInstanceManager();
    seed(manager, {
      actorId: 'mob',
      npcTypeId: 8080,
      position: [5, 5],
      size: 1,
      facing: 0,
      rotationSpeed: 32,
      intent: { kind: 'turn-to-angle', angle: 512 },
    });
    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);
    expect(trackerFor(manager, 'mob')).toBeDefined();

    manager.dispose();

    expect(trackerFor(manager, 'mob')).toBeUndefined();
    expect(manager.getPrimaryNpcSmoothedFacingAngle()).toBeUndefined();
  });

  it('clears the cached primary angle when the primary boss dies', () => {
    const manager = new NpcInstanceManager();
    setPrimaryConfig(manager);
    seed(manager, {
      actorId: PRIMARY_NPC_ACTOR_ID,
      npcTypeId: PRIMARY_TYPE_ID,
      position: PRIMARY_BASE_POS,
      size: PRIMARY_SIZE,
      facing: 0,
      rotationSpeed: 32,
      intent: { kind: 'track-actor', targetId: 'player' },
      bossDeathAnimationEnabled: true,
    });
    manager.updateNpcVisualFacing([33, 39], CLIENT_CYCLE_MS);
    expect(manager.getPrimaryNpcSmoothedFacingAngle()).toBe(2016);

    manager.syncInstances([
      makeSnapshot({
        id: PRIMARY_NPC_ACTOR_ID,
        npcTypeId: PRIMARY_TYPE_ID,
        position: PRIMARY_BASE_POS,
        size: PRIMARY_SIZE,
        role: 'boss',
        alive: false,
      }),
    ]);

    expect(manager.getPrimaryNpcSmoothedFacingAngle()).toBeUndefined();
    expect(trackerFor(manager, PRIMARY_NPC_ACTOR_ID)).toBeUndefined();
  });
});

describe('NpcInstanceManager death lifecycle', () => {
  const actorId = 'test-corpse';
  const npcTypeId = 9200;

  function deadSnapshot() {
    return makeSnapshot({ id: actorId, npcTypeId, position: [10, 10], size: 1, alive: false });
  }

  function managerWithLiveNpc(): NpcInstanceManager {
    const manager = new NpcInstanceManager();
    seed(manager, {
      actorId,
      npcTypeId,
      position: [10, 10],
      size: 1,
      facing: 0,
      rotationSpeed: 32,
    });
    return manager;
  }

  it('retains a dead non-boss NPC as a renderable corpse', () => {
    const manager = managerWithLiveNpc();

    manager.syncInstances([deadSnapshot()]);

    expect(manager.getDyingActorIds()).toEqual(new Set([actorId]));
    expect(manager.getModelMatrix(actorId)).not.toBeNull();
    expect(manager.getVisualPosition(actorId)).toBeNull();
    expect(manager.getInstanceFrameStates().map(({ actorId: id }) => id)).toContain(actorId);
  });

  it.each(['minion', 'boss'] as const)('retains an ordinary %s corpse when its world snapshot is pruned', (role) => {
    const manager = managerWithLiveNpc();
    manager['typeRegistry'].set(npcTypeId, {
      ...makeTypeRegistryEntry(npcTypeId, 1, 32),
      bossDeathAnimationEnabled: true,
    });
    manager.syncInstances([{ ...deadSnapshot(), role }]);

    manager.syncInstances([]);
    const queue = createQueue();
    manager.renderAll(queue);

    expect(manager.getDyingActorIds()).toEqual(new Set([actorId]));
    expect(queue.commands).toHaveLength(1);
  });

  it('leaves out the live and dying instances a hiding plugin names, asking with type and death state', () => {
    const manager = managerWithLiveNpc();
    const asked: Array<[string, number, boolean]> = [];
    const hideAll = (id: string, typeId: number, dying: boolean) => {
      asked.push([id, typeId, dying]);
      return true;
    };

    const liveQueue = createQueue();
    manager.renderAll(liveQueue, hideAll);
    manager.syncInstances([deadSnapshot()]);
    const corpseQueue = createQueue();
    manager.renderAll(corpseQueue, hideAll);
    const shownQueue = createQueue();
    manager.renderAll(shownQueue, () => false);

    expect(asked).toEqual([
      [actorId, npcTypeId, false],
      [actorId, npcTypeId, true],
    ]);
    expect(liveQueue.commands).toHaveLength(0);
    expect(corpseQueue.commands).toHaveLength(0);
    expect(shownQueue.commands).toHaveLength(1);
    expect(manager.getDyingActorIds()).toEqual(new Set([actorId]));
  });

  it('removes a live direct despawn immediately without creating a corpse', () => {
    const manager = managerWithLiveNpc();

    manager.syncInstances([]);
    const queue = createQueue();
    manager.renderAll(queue);

    expect(manager.getDyingActorIds().size).toBe(0);
    expect(queue.commands).toHaveLength(0);
  });

  it.each([false, true])('clears all presentation state on explicit removal when dying is %s', (dying) => {
    const manager = managerWithLiveNpc();
    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);
    if (dying) manager.syncInstances([deadSnapshot()]);
    manager.getDyingActorIds();
    manager.updateAnimations(0, 1, [{ actorId, trigger: 'attack', tick: 1 }]);

    manager.removePresentation(actorId);
    const queue = createQueue();
    manager.renderAll(queue);

    expect(queue.commands).toHaveLength(0);
    expect(manager.getDyingActorIds().size).toBe(0);
    expect(manager.getModelMatrix(actorId)).toBeNull();
    expect(manager.getInstanceFrameStates()).toEqual([]);
    expect(manager['pendingAttackTriggersByActor'].has(actorId)).toBe(false);
    expect(trackerFor(manager, actorId)).toBeUndefined();
  });

  it.each(['actor', 'type'] as const)('clears a long-hold Yt-HurKot corpse by %s without capping its clip', (scope) => {
    const manager = new NpcInstanceManager();
    const death = presentationClip('death', 2638, [...Array<number>(20).fill(4), 10, 20000]);
    manager['typeRegistry'].set(7705, {
      ...makeTypeRegistryEntry(7705, 1, 32),
      animationSet: { idle: presentationClip('idle', 0), death },
    });
    manager['instanceRegistry'].set(actorId, makeInstance(actorId, 7705, new Float32Array(16)));
    manager.syncInstances([makeSnapshot({ id: actorId, npcTypeId: 7705, position: [10, 10], size: 1, alive: false })]);
    manager.syncInstances([]);
    manager.updateAnimations(401780, 1, []);
    expect(manager.getDyingActorIds()).toEqual(new Set([actorId]));

    if (scope === 'actor') manager.removePresentation(actorId);
    else manager.removePresentationsByNpcType([7705]);
    const queue = createQueue();
    manager.renderAll(queue);

    expect(queue.commands).toHaveLength(0);
    expect(manager.getDyingActorIds().size).toBe(0);
    expect(manager.getInstanceFrameStates()).toEqual([]);
  });

  it('removes only matching live and dying types together with their pending cues', () => {
    const manager = managerWithLiveNpc();
    const actors = [
      { id: actorId, npcTypeId, alive: false },
      { id: 'selected-live', npcTypeId: 7705, alive: true },
      { id: 'retained-live', npcTypeId: 9210, alive: true },
      { id: 'retained-corpse', npcTypeId: 9211, alive: false },
    ];
    for (const actor of actors.slice(1)) {
      seed(manager, {
        actorId: actor.id,
        npcTypeId: actor.npcTypeId,
        position: [10, 10],
        size: 1,
        facing: 0,
        rotationSpeed: 32,
      });
    }
    manager.syncInstances(actors.map((actor) => makeSnapshot({ ...actor, position: [10, 10], size: 1 })));
    manager.updateAnimations(
      0,
      1,
      actors.map((actor) => ({ actorId: actor.id, trigger: 'attack', tick: 1 })),
    );
    manager.getDyingActorIds();

    manager.removePresentationsByNpcType([npcTypeId, 7705]);
    const queue = createQueue();
    manager.renderAll(queue);

    expect(manager.getInstanceFrameStates().map((state) => state.actorId)).toEqual([
      'retained-live',
      'retained-corpse',
    ]);
    expect(manager.getDyingActorIds()).toEqual(new Set(['retained-corpse']));
    expect([...manager['pendingAttackTriggersByActor'].keys()]).toEqual(['retained-live', 'retained-corpse']);
    expect(queue.commands).toHaveLength(2);
  });

  it('preserves a replacement instance synced after an explicit by-type clear', () => {
    const manager = managerWithLiveNpc();
    manager.syncInstances([deadSnapshot()]);
    manager.syncInstances([]);

    manager.removePresentationsByNpcType([npcTypeId]);
    manager.syncInstances([makeSnapshot({ id: 'replacement', npcTypeId, position: [12, 12], size: 1 })]);

    expect(manager.getDyingActorIds().size).toBe(0);
    expect(manager.getInstanceFrameStates().map((state) => state.actorId)).toEqual(['replacement']);
    expect(manager.getVisualPosition('replacement')).toEqual([12, 12]);
  });

  it('removes a retained corpse after the default death duration', () => {
    const manager = managerWithLiveNpc();
    manager.syncInstances([deadSnapshot()]);

    manager.updateAnimations(OSRS_TICK_MS, 1, []);

    expect(manager.getDyingActorIds()).toEqual(new Set());
    expect(manager.getModelMatrix(actorId)).toBeNull();
    expect(manager.getInstanceFrameStates().map(({ actorId: id }) => id)).not.toContain(actorId);
  });

  it('reconstructs one corpse idempotently and removes it at the duration boundary', () => {
    const manager = new NpcInstanceManager();
    registerType(manager, npcTypeId, 1, 32);
    const snapshot = deadSnapshot();

    manager.reconstructDyingInstance(snapshot, 0);
    manager.reconstructDyingInstance(snapshot, 0);

    expect(manager.getDyingActorIds()).toEqual(new Set([actorId]));
    expect(manager.getModelMatrix(actorId)).not.toBeNull();

    manager.reconstructDyingInstance(snapshot, OSRS_TICK_MS - 1);
    expect(manager.getDyingActorIds()).toEqual(new Set([actorId]));

    manager.reconstructDyingInstance(snapshot, OSRS_TICK_MS);
    expect(manager.getDyingActorIds()).toEqual(new Set());
    expect(manager.getModelMatrix(actorId)).toBeNull();
  });

  it('reports the longest loaded death presentation duration', () => {
    const manager = new NpcInstanceManager();
    manager['typeRegistry'].set(1, { ...makeTypeRegistryEntry(1, 1, 32), deathDurationMs: 600 });
    manager['typeRegistry'].set(2, { ...makeTypeRegistryEntry(2, 1, 32), deathDurationMs: 1800 });

    expect(manager.getMaximumLoadedDeathDurationMs()).toBe(1800);
  });
});

describe('NpcInstanceManager.getHitTestData', () => {
  function setupManager(dynamicFaceColors3: Int32Array | null, typeFaceColors3: Int32Array | null) {
    const manager = new NpcInstanceManager();

    const mergedModel = {
      verticesX: new Int32Array([0, 64, 0]),
      verticesY: new Int32Array([0, 0, 64]),
      verticesZ: new Int32Array([0, 0, 0]),
      verticesCount: 3,
      indices1: new Int32Array([0]),
      indices2: new Int32Array([1]),
      indices3: new Int32Array([2]),
      faceCount: 1,
    };

    const typeData = {
      npcTypeId: 123,
      modelData: { mergedModel },
      litColors: typeFaceColors3 ? { faceColors3: typeFaceColors3 } : null,
    };

    const instance = {
      actorId: 'npc-a',
      npcTypeId: 123,
      posedVerticesX: null,
      posedVerticesY: null,
      posedVerticesZ: null,
      originalVerticesX: null,
      originalVerticesY: null,
      originalVerticesZ: null,
      dynamicFaceColors3,
      currentModelMatrix: new Float32Array(16),
    };

    (manager as any).typeRegistry.set(123, typeData as any);
    (manager as any).instanceRegistry.set('npc-a', instance as any);

    return manager;
  }

  it('returns litColors.faceColors3 when dynamicFaceColors3 is null', () => {
    const typeFaceColors3 = new Int32Array([111]);
    const manager = setupManager(null, typeFaceColors3);

    const data = manager.getHitTestData('npc-a');

    expect(data).not.toBeNull();
    expect(data!.faceColors3).toBe(typeFaceColors3);
  });

  it('returns dynamicFaceColors3 when present', () => {
    const dynamicFaceColors3 = new Int32Array([222]);
    const typeFaceColors3 = new Int32Array([111]);
    const manager = setupManager(dynamicFaceColors3, typeFaceColors3);

    const data = manager.getHitTestData('npc-a');

    expect(data).not.toBeNull();
    expect(data!.faceColors3).toBe(dynamicFaceColors3);
  });

  it('returns null faceColors3 when both dynamic and type colors are null', () => {
    const manager = setupManager(null, null);

    const data = manager.getHitTestData('npc-a');

    expect(data).not.toBeNull();
    expect(data!.faceColors3).toBeNull();
  });
});

describe('NpcInstanceManager posed overlay geometry', () => {
  function setup() {
    const manager = new NpcInstanceManager();
    const model = new ModelData();
    model.verticesCount = 3;
    model.verticesX = new Int32Array([-64, 64, 0]);
    model.verticesY = new Int32Array([-47, 145, 0]);
    model.verticesZ = new Int32Array([0, 0, 64]);
    const typeData = {
      ...makeTypeRegistryEntry(7708, 1, 32),
      modelData: { ...makeNpcModelData(7708, 1, 32), mergedModel: model },
      modelBounds: { minX: -64, maxX: 64, minY: -47.5, maxY: 145.5, minZ: 0, maxZ: 64 },
      restVerticesX: new Int32Array(model.verticesX),
      restVerticesY: new Int32Array(model.verticesY),
      restVerticesZ: new Int32Array(model.verticesZ),
    };
    manager['typeRegistry'].set(7708, typeData);
    manager.syncInstances([makeSnapshot({ id: 'healer', npcTypeId: 7708, size: 1, position: [10, 10] })]);
    const instance = manager['instanceRegistry'].get('healer');
    if (!instance) throw new Error('Missing fixture instance');
    return { manager, model, typeData, instance };
  }

  it('retains scaled type heights until the first pose has been committed', () => {
    const { manager, typeData } = setup();
    typeData.heightScale = 35;

    expect(manager.getNpcOverlayHeights('healer')?.hitsplatHeight).toBe((47.5 * 35) / 128 / 256);
  });

  it('uses each actor pose for half-height splats without scaling committed vertices twice', () => {
    const { manager, instance, typeData } = setup();
    typeData.heightScale = 35;
    instance.posedVerticesY = new Int32Array([-113, 1, -60]);
    const sibling = { ...instance, actorId: 'sibling', posedVerticesY: new Int32Array([-200, 0, -60]) };
    manager['instanceRegistry'].set('sibling', sibling);

    expect(manager.getNpcOverlayHeights('healer')).toEqual({
      hitsplatHeight: 113 / 256,
      healthBarHeight: 1,
      healthBarWidth: 40,
      baseHeight: 0,
    });
    expect(manager.getNpcOverlayHeights('sibling')?.hitsplatHeight).toBe(200 / 256);
  });

  it('uses the rendered model base including terrain and sequence lift', () => {
    const { manager, instance } = setup();
    instance.posedVerticesY = new Int32Array([-256, 0, -128]);
    instance.currentModelMatrix[14] = 2.5;

    expect(manager.getNpcOverlayHeights('healer')).toEqual({
      hitsplatHeight: 1,
      healthBarHeight: 271 / 128,
      healthBarWidth: 40,
      baseHeight: 2.5,
    });
  });

  it('does not turn a fully submerged pose into a negative model height', () => {
    const { manager, instance } = setup();
    instance.posedVerticesY = new Int32Array([145, 484, 200]);

    expect(manager.getNpcOverlayHeights('healer')?.hitsplatHeight).toBe(0);
  });

  it('returns no geometry for an absent actor', () => {
    const { manager } = setup();

    expect(manager.getNpcOverlayHeights('absent')).toBeNull();
  });

  it('exposes the model depth bias to highlights for live and dying actors', () => {
    const { manager, typeData } = setup();
    manager['typeRegistry'].set(7708, { ...typeData, depthBias: 0.0005 });

    expect(manager.getHitTestData('healer')).toMatchObject({ depthBias: 0.0005 });
    manager.syncInstances([makeSnapshot({ id: 'healer', npcTypeId: 7708, size: 1, position: [10, 10], alive: false })]);
    expect(manager.getHitTestData('healer')).toMatchObject({ depthBias: 0.0005 });
  });

  it('refreshes posed highlight and picking vertices when a death controller is created lazily', () => {
    const { manager, model, typeData, instance } = setup();
    manager['animSystem'] = new AnimationSystem();
    const animationSet = { idle: presentationClip('idle', 1), death: presentationClip('death', 2) };
    manager['typeRegistry'].set(7708, { ...typeData, animationSet });
    manager.syncInstances([makeSnapshot({ id: 'healer', npcTypeId: 7708, size: 1, position: [10, 10], alive: false })]);
    if (!instance.modelAdapter) throw new Error('Missing death adapter');
    instance.modelAdapter.resetPose();
    model.translate(0, -256, 0);

    instance.modelAdapter.commitPose();

    expect(manager.getHitTestData('healer')?.verticesY).toEqual(new Int32Array([-303, -111, -256]));
    expect(manager.getNpcOverlayHeights('healer')?.hitsplatHeight).toBe(303 / 256);
  });
});

describe('NpcInstanceManager death clip by death cause', () => {
  const TYPE_ID = 14179;
  const flare = (overrides: Partial<NpcSnapshot> = {}) => ({
    ...makeSnapshot({ id: 'flare', npcTypeId: TYPE_ID, position: [10, 10], size: 2 }),
    ...overrides,
  });

  function setup() {
    const manager = new NpcInstanceManager();
    manager['animSystem'] = new AnimationSystem();
    const model = new ModelData();
    model.verticesCount = 3;
    model.verticesX = new Int32Array([-64, 64, 0]);
    model.verticesY = new Int32Array([-47, 145, 0]);
    model.verticesZ = new Int32Array([0, 0, 64]);
    manager['typeRegistry'].set(TYPE_ID, {
      ...makeTypeRegistryEntry(TYPE_ID, 2, 32),
      modelData: { ...makeNpcModelData(TYPE_ID, 2, 32), mergedModel: model },
      restVerticesX: new Int32Array(model.verticesX),
      restVerticesY: new Int32Array(model.verticesY),
      restVerticesZ: new Int32Array(model.verticesZ),
      animationSet: {
        idle: presentationClip('idle', 12133),
        death: presentationClip('death', 12134, [30, 30, 30]),
        deathClips: { detonated: presentationClip('death:detonated', 12136, [10, 10, 10]) },
      },
      deathClipDurationsMs: { detonated: 1200 },
    });
    return manager;
  }
  const dyingFrame = (manager: NpcInstanceManager) =>
    manager['dyingInstances'].get('flare')?.instance.animController?.getFrameState();

  it.each([
    { cause: 'detonated', seqId: 12136, durationMs: 1200 },
    { cause: undefined, seqId: 12134, durationMs: 1800 },
    { cause: 'unknown', seqId: 12134, durationMs: 1800 },
    // Replay snapshots carry the cause verbatim; inherited object keys must not resolve to a clip.
    { cause: '__proto__', seqId: 12134, durationMs: 1800 },
    { cause: 'constructor', seqId: 12134, durationMs: 1800 },
    { cause: 'toString', seqId: 12134, durationMs: 1800 },
  ])('plays $seqId for cause $cause and retains the corpse $durationMs ms', ({ cause, seqId, durationMs }) => {
    const manager = setup();
    manager.syncInstances([flare()]);
    manager.syncInstances([flare({ alive: false, ...(cause ? { deathCause: cause } : {}) })]);

    expect(dyingFrame(manager)).toMatchObject({ seqId, currentFrameIndex: 0 });
    manager.updateAnimations(durationMs - 1, 1, []);
    expect(manager.getDyingActorIds().has('flare')).toBe(true);
    manager.updateAnimations(1, 1, []);
    expect(manager.getDyingActorIds().has('flare')).toBe(false);
  });

  it('reconstructs a corpse on its cause clip and retention', () => {
    const manager = setup();
    const corpse = flare({ alive: false, deathCause: 'detonated' });

    manager.reconstructDyingInstance(corpse, 15 * CLIENT_CYCLE_MS);
    expect(dyingFrame(manager)).toMatchObject({ seqId: 12136, currentFrameIndex: 1 });

    manager.reconstructDyingInstance(corpse, 1200);
    expect(manager.getDyingActorIds().has('flare')).toBe(false);
    expect(manager.getMaximumLoadedDeathDurationMs()).toBe(1800);
  });
});

describe('NpcInstanceManager spawn clip', () => {
  const TYPE_ID = 14179;
  const IDLE_SEQ = 12133;
  const SPAWN_SEQ = 12135;
  const SPAWN_TICK = 10;
  const SPAWN_CYCLE = SPAWN_TICK * 30;
  // presentationClip's default lengths: four 2-cycle frames, an 8-cycle clip.
  const SPAWN_CYCLES = 8;
  const SOUND_FRAME = 2;
  const SOUND_ID = 10253;

  function setup({ withSpawn = true } = {}) {
    const manager = new NpcInstanceManager();
    manager['animSystem'] = new AnimationSystem();
    const model = new ModelData();
    model.verticesCount = 3;
    model.verticesX = new Int32Array([-64, 64, 0]);
    model.verticesY = new Int32Array([-47, 145, 0]);
    model.verticesZ = new Int32Array([0, 0, 64]);
    const idle = presentationClip('idle', IDLE_SEQ);
    const spawn = presentationClip('spawn', SPAWN_SEQ);
    spawn.seqType.frameSounds = new Map([[SOUND_FRAME, [new SeqSoundEffect(SOUND_ID, 1, 0, 0)]]]);
    manager['typeRegistry'].set(TYPE_ID, {
      ...makeTypeRegistryEntry(TYPE_ID, 2, 32),
      modelData: { ...makeNpcModelData(TYPE_ID, 2, 32), mergedModel: model },
      restVerticesX: new Int32Array(model.verticesX),
      restVerticesY: new Int32Array(model.verticesY),
      restVerticesZ: new Int32Array(model.verticesZ),
      animationSet: withSpawn ? { idle, spawn } : { idle },
    });
    return manager;
  }

  const flare = (spawnTick = SPAWN_TICK) => ({
    ...makeSnapshot({ id: 'flare', npcTypeId: TYPE_ID, position: [10, 10], size: 2 }),
    spawnTick,
  });

  /** One rendered frame: sync at `cycle`, then advance by `deltaCycles`. */
  function at(manager: NpcInstanceManager, cycle: number, deltaCycles = 0) {
    manager.syncInstances([flare()], 0, cycle);
    manager.updateAnimations(deltaCycles * CLIENT_CYCLE_MS, 1, []);
    return manager['instanceRegistry'].get('flare')?.animController?.getFrameState();
  }

  it('starts at the spawn tick and returns to idle once the clip has played', () => {
    const manager = setup();

    expect(at(manager, SPAWN_CYCLE)).toMatchObject({ seqId: SPAWN_SEQ, currentFrameIndex: 0 });
    expect(at(manager, SPAWN_CYCLE + 4, 4)).toMatchObject({ seqId: SPAWN_SEQ, currentFrameIndex: 2 });
    expect(at(manager, SPAWN_CYCLE + SPAWN_CYCLES, 4)).toMatchObject({ seqId: IDLE_SEQ });
  });

  it('lands on the spawn-tick phase when first seen mid-clip and later syncs do not restart it', () => {
    const manager = setup();

    expect(at(manager, SPAWN_CYCLE + 5)).toMatchObject({ seqId: SPAWN_SEQ, currentFrameIndex: 2 });
    expect(at(manager, SPAWN_CYCLE + 6, 1)).toMatchObject({ seqId: SPAWN_SEQ, currentFrameIndex: 3 });
  });

  it('re-derives the clip phase from the spawn tick after a timeline discontinuity', () => {
    const manager = setup();
    at(manager, SPAWN_CYCLE + 6);

    manager.resetTransientState();
    expect(at(manager, SPAWN_CYCLE + 3)).toMatchObject({ seqId: SPAWN_SEQ, currentFrameIndex: 1 });

    manager.resetTransientState();
    expect(at(manager, SPAWN_CYCLE + 40)).toMatchObject({ seqId: IDLE_SEQ });
  });

  it('just idles when first seen after the clip has finished', () => {
    expect(at(setup(), SPAWN_CYCLE + SPAWN_CYCLES)).toMatchObject({ seqId: IDLE_SEQ });
  });

  it('waits for the clock to reach a spawn tick still ahead of it', () => {
    const manager = setup();

    expect(at(manager, SPAWN_CYCLE - 30)).toMatchObject({ seqId: IDLE_SEQ });
    expect(at(manager, SPAWN_CYCLE + 1, 31)).toMatchObject({ seqId: SPAWN_SEQ, currentFrameIndex: 0 });
  });

  it('plays nothing for a type without a spawn clip or a sync without a presentation clock', () => {
    expect(at(setup({ withSpawn: false }), SPAWN_CYCLE)).toMatchObject({ seqId: IDLE_SEQ });

    const manager = setup();
    manager.syncInstances([flare()]);
    manager.updateAnimations(0, 1, []);
    expect(manager['instanceRegistry'].get('flare')?.animController?.getFrameState()).toMatchObject({
      seqId: IDLE_SEQ,
    });
  });

  it('keeps the spawn clip when a replay primary timeline has nothing to restore', () => {
    const manager = setup();
    at(manager, SPAWN_CYCLE);
    const timeline = new ReplayPrimaryIndex<Parameters<NpcInstanceManager['updateAnimations']>[2][number], AnimClipRef>(
      [],
    );

    manager.restoreReplayPrimary('flare', timeline, { cycle: SPAWN_CYCLE + 3, throughFrameIndex: 0 });
    manager.updateAnimations(0, 1, []);

    expect(manager['instanceRegistry'].get('flare')?.animController?.getFrameState()).toMatchObject({
      seqId: SPAWN_SEQ,
      currentFrameIndex: 1,
    });
  });

  it('fires the spawn frame sound once in playback and never on a silent seek', () => {
    const manager = setup();
    const play = vi.fn();
    const tracker = new FrameSoundTracker({ play } as unknown as AudioEngine);
    const states = (): ActorFrameState[] =>
      manager.getInstanceFrameStates().flatMap(({ actorId, animController, center }) => {
        const state = animController?.getFrameState();
        return state
          ? [
              {
                actorId,
                seqId: state.seqId,
                currentFrame: state.currentFrameIndex,
                seqType: state.seqType,
                position: center,
              },
            ]
          : [];
      });
    const playFrom = (from: number, to: number) => {
      for (let cycle = from; cycle <= to; cycle++) {
        at(manager, cycle, cycle === SPAWN_CYCLE ? 0 : 1);
        tracker.update(states(), [10, 10]);
      }
    };

    playFrom(SPAWN_CYCLE, SPAWN_CYCLE + SPAWN_CYCLES + 2);
    expect(play.mock.calls.map(([id]) => id)).toEqual([SOUND_ID]);

    // Seek onto the sound frame the way the compositor does: reset, re-derive, silently sync.
    manager.resetTransientState();
    at(manager, SPAWN_CYCLE + 4);
    tracker.silentSync(states());
    playFrom(SPAWN_CYCLE + 5, SPAWN_CYCLE + SPAWN_CYCLES + 2);

    expect(play).toHaveBeenCalledOnce();
  });
});

/**
 * The NPC vertical lift is the active sequence's cache `heightOffset` and NOTHING else.
 *
 * No model-bottom "anti-sink" term: it would never fire for an NPC stood on the floor (a flat
 * base cap sits at model Y=0), and would only fire for models authored to sit BELOW their
 * origin — TzKal-Zuk seated into his throne loc, Jal-MejJak sprung up out of the ground —
 * hoisting exactly those into the air. Coincident-surface z-fighting is handled by `depthBias`.
 */
describe('NpcInstanceManager NPC model lift', () => {
  it('adds no model-derived lift when the animation heightOffset is zero', () => {
    expect(npcModelLiftFromAnimationHeightOffset(0)).toBe(0);
  });

  it('applies the sequence heightOffset as the whole lift', () => {
    expect(npcModelLiftFromAnimationHeightOffset(-16)).toBe(-16);
  });

  it('treats an NPC with no animation controller as unlifted', () => {
    expect(npcModelLiftFromAnimationHeightOffset(undefined)).toBe(0);
  });
});

const playerBearingFrom = (position: [number, number], size: number, player: [number, number]): number =>
  bearing(position[0] + size / 2, position[1] + size / 2, player[0] + 0.5, player[1] + 0.5);

/**
 * The primary NPC follows its render-facing intent exactly like any other actor
 * (fixed / turn-to-angle / track-actor). Only a MISSING primary intent uses the
 * exact-player fallback. The smoothed angle is cached for projectile
 * targeting and cleared when no primary is live.
 */
describe('NpcInstanceManager primary NPC facing', () => {
  it('reproduces the exact off-axis 1095 -> 2016 track-player result via the generic pass', () => {
    const manager = new NpcInstanceManager();
    setPrimaryConfig(manager);
    seed(manager, {
      actorId: PRIMARY_NPC_ACTOR_ID,
      npcTypeId: PRIMARY_TYPE_ID,
      position: PRIMARY_BASE_POS,
      size: PRIMARY_SIZE,
      facing: 0,
      rotationSpeed: 32,
      intent: { kind: 'track-actor', targetId: 'player' },
    });

    const returned = manager.updateNpcVisualFacing([33, 39], CLIENT_CYCLE_MS);

    expect(playerBearingFrom(PRIMARY_BASE_POS, PRIMARY_SIZE, [33, 39])).toBe(1095);
    expect(returned).toBe(2016);
    expect(manager.getPrimaryNpcSmoothedFacingAngle()).toBe(2016);
    expect(appliedAngle(manager, PRIMARY_NPC_ACTOR_ID)).toBe(2016);
  });

  it('uses the exact-player fallback ONLY when the primary has no intent', () => {
    const manager = new NpcInstanceManager();
    setPrimaryConfig(manager);
    seed(manager, {
      actorId: PRIMARY_NPC_ACTOR_ID,
      npcTypeId: PRIMARY_TYPE_ID,
      position: PRIMARY_BASE_POS,
      size: PRIMARY_SIZE,
      facing: 0,
      rotationSpeed: 32,
      // intent omitted -> missing
    });

    manager.updateNpcVisualFacing([33, 39], CLIENT_CYCLE_MS);

    expect(appliedAngle(manager, PRIMARY_NPC_ACTOR_ID)).toBe(2016);
  });

  it('honors a fixed intent for the primary (snaps to angle, does NOT track the player)', () => {
    const manager = new NpcInstanceManager();
    setPrimaryConfig(manager);
    seed(manager, {
      actorId: PRIMARY_NPC_ACTOR_ID,
      npcTypeId: PRIMARY_TYPE_ID,
      position: PRIMARY_BASE_POS,
      size: PRIMARY_SIZE,
      facing: 1024,
      rotationSpeed: 32,
      intent: { kind: 'fixed', angle: 0 },
    });

    manager.updateNpcVisualFacing([33, 39], CLIENT_CYCLE_MS);

    expect(appliedAngle(manager, PRIMARY_NPC_ACTOR_ID)).toBe(0);
    expect(appliedAngle(manager, PRIMARY_NPC_ACTOR_ID)).not.toBe(
      playerBearingFrom(PRIMARY_BASE_POS, PRIMARY_SIZE, [33, 39]),
    );
  });

  it('honors a turn-to-angle intent for the primary (movement precedence, NOT the player)', () => {
    const manager = new NpcInstanceManager();
    setPrimaryConfig(manager);
    seed(manager, {
      actorId: PRIMARY_NPC_ACTOR_ID,
      npcTypeId: PRIMARY_TYPE_ID,
      position: PRIMARY_BASE_POS,
      size: PRIMARY_SIZE,
      facing: 0,
      rotationSpeed: 32,
      intent: { kind: 'turn-to-angle', angle: 1024 },
    });

    manager.updateNpcVisualFacing([33, 39], CLIENT_CYCLE_MS);

    expect(appliedAngle(manager, PRIMARY_NPC_ACTOR_ID)).toBe(expectedSmoothed(0, 1024, 32));
    expect(appliedAngle(manager, PRIMARY_NPC_ACTOR_ID)).not.toBe(
      playerBearingFrom(PRIMARY_BASE_POS, PRIMARY_SIZE, [33, 39]),
    );
  });

  it('tracks a non-player target for a primary that targets another actor (Zuk -> shield)', () => {
    const manager = new NpcInstanceManager();
    setPrimaryConfig(manager);
    seed(manager, {
      actorId: PRIMARY_NPC_ACTOR_ID,
      npcTypeId: PRIMARY_TYPE_ID,
      position: [10, 10],
      size: PRIMARY_SIZE,
      facing: 0,
      rotationSpeed: 4096,
      intent: { kind: 'track-actor', targetId: 'shield' },
    });
    seed(manager, { actorId: 'shield', npcTypeId: 8060, position: [12, 25], size: 3, facing: 0, rotationSpeed: 32 });

    manager.updateNpcVisualFacing([80, 80], CLIENT_CYCLE_MS);

    const shieldCenter = bearing(12.5, 12.5, 13.5, 26.5);
    expect(appliedAngle(manager, PRIMARY_NPC_ACTOR_ID)).toBe(shieldCenter);
    expect(appliedAngle(manager, PRIMARY_NPC_ACTOR_ID)).not.toBe(playerBearingFrom([10, 10], PRIMARY_SIZE, [80, 80]));
  });

  it('falls back to the authoritative snapshot angle (NOT the player) when a primary track target is unresolved', () => {
    const manager = new NpcInstanceManager();
    setPrimaryConfig(manager);
    seed(manager, {
      actorId: PRIMARY_NPC_ACTOR_ID,
      npcTypeId: PRIMARY_TYPE_ID,
      position: PRIMARY_BASE_POS,
      size: PRIMARY_SIZE,
      facing: 700, // authoritative snapshot angle
      rotationSpeed: 32,
      intent: { kind: 'track-actor', targetId: 'ghost' }, // no live instance
    });

    manager.updateNpcVisualFacing([33, 39], CLIENT_CYCLE_MS);

    expect(appliedAngle(manager, PRIMARY_NPC_ACTOR_ID)).toBe(700);
    expect(appliedAngle(manager, PRIMARY_NPC_ACTOR_ID)).not.toBe(
      playerBearingFrom(PRIMARY_BASE_POS, PRIMARY_SIZE, [33, 39]),
    );
  });

  it('clears the cached primary angle when the all-NPC update has no live primary', () => {
    const manager = new NpcInstanceManager();
    setPrimaryConfig(manager);
    seed(manager, {
      actorId: PRIMARY_NPC_ACTOR_ID,
      npcTypeId: PRIMARY_TYPE_ID,
      position: PRIMARY_BASE_POS,
      size: PRIMARY_SIZE,
      facing: 0,
      rotationSpeed: 32,
      intent: { kind: 'track-actor', targetId: 'player' },
    });
    manager.updateNpcVisualFacing([33, 39], CLIENT_CYCLE_MS);
    expect(manager.getPrimaryNpcSmoothedFacingAngle()).toBe(2016);

    // Primary despawns; the next all-NPC pass sees no primary.
    deleteInstance(manager, PRIMARY_NPC_ACTOR_ID);
    const returned = manager.updateNpcVisualFacing([33, 39], CLIENT_CYCLE_MS);

    expect(returned).toBeUndefined();
    expect(manager.getPrimaryNpcSmoothedFacingAngle()).toBeUndefined();
  });
});

/**
 * Generic (non-primary) smooth turning through
 * {@link NpcInstanceManager.updateNpcVisualFacing}: every NPC turns toward
 * whatever its render-facing intent points at.
 */
describe('NpcInstanceManager.updateNpcVisualFacing (generic smooth turning)', () => {
  it('smooths a secondary NPC toward another NPC it tracks (healer/shield style), not a snap', () => {
    const manager = new NpcInstanceManager();
    seed(manager, {
      actorId: 'source',
      npcTypeId: 8001,
      position: [10, 10],
      size: 1,
      facing: 0,
      rotationSpeed: 32,
      intent: { kind: 'track-actor', targetId: 'target' },
    });
    seed(manager, { actorId: 'target', npcTypeId: 8002, position: [10, 20], size: 1, facing: 0, rotationSpeed: 32 });

    const target = bearing(10.5, 10.5, 10.5, 20.5); // due north -> 1024
    expect(target).toBe(1024);
    const expected = expectedSmoothed(0, target, 32); // one 32-step cycle from 0 -> 32

    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);

    // Smoothed one step toward the bearing: not snapped to target, not left at seed.
    expect(appliedAngle(manager, 'source')).toBe(expected);
    expect(appliedAngle(manager, 'source')).not.toBe(target);
    expect(appliedAngle(manager, 'source')).not.toBe(0);
  });

  it('recomputes the target visual center every frame as the tracked NPC moves', () => {
    // rotationSpeed 4096 snaps to the target each cycle, isolating the center recompute.
    const manager = new NpcInstanceManager();
    seed(manager, {
      actorId: 'source',
      npcTypeId: 8010,
      position: [10, 10],
      size: 1,
      facing: 0,
      rotationSpeed: 4096,
      intent: { kind: 'track-actor', targetId: 'mover' },
    });
    seed(manager, { actorId: 'mover', npcTypeId: 8011, position: [10, 20], size: 1, facing: 0, rotationSpeed: 32 });

    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);
    const firstBearing = bearing(10.5, 10.5, 10.5, 20.5);
    expect(appliedAngle(manager, 'source')).toBe(firstBearing);

    mutableInstance(manager, 'mover').lastRenderPosition = [30, 10];
    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);

    const secondBearing = bearing(10.5, 10.5, 30.5, 10.5);
    expect(secondBearing).not.toBe(firstBearing);
    expect(appliedAngle(manager, 'source')).toBe(secondBearing);
  });

  it('smooths a turn-to-angle intent toward its angle regardless of any target', () => {
    const manager = new NpcInstanceManager();
    seed(manager, {
      actorId: 'walker',
      npcTypeId: 8020,
      position: [5, 5],
      size: 1,
      facing: 0,
      rotationSpeed: 32,
      intent: { kind: 'turn-to-angle', angle: 1536 },
    });

    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);

    expect(appliedAngle(manager, 'walker')).toBe(expectedSmoothed(0, 1536, 32));
  });

  it('snaps a fixed-facing NPC exactly to its angle, discarding a prior turn', () => {
    const manager = new NpcInstanceManager();
    seed(manager, {
      actorId: 'shield',
      npcTypeId: 8030,
      position: [5, 5],
      size: 1,
      facing: 0,
      rotationSpeed: 32,
      intent: { kind: 'turn-to-angle', angle: 1024 },
    });
    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);
    expect(appliedAngle(manager, 'shield')).not.toBe(0);

    // Intent flips to fixed(0) (Zuk's shield never rotates).
    mutableInstance(manager, 'shield').currentFacingIntent = { kind: 'fixed', angle: 0 };
    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);

    expect(appliedAngle(manager, 'shield')).toBe(0);
  });

  it('advances two actors independently at their own rotation speeds', () => {
    const manager = new NpcInstanceManager();
    seed(manager, {
      actorId: 'slow',
      npcTypeId: 8040,
      position: [5, 5],
      size: 1,
      facing: 0,
      rotationSpeed: 32,
      intent: { kind: 'turn-to-angle', angle: 1024 },
    });
    seed(manager, {
      actorId: 'fast',
      npcTypeId: 8041,
      position: [8, 8],
      size: 1,
      facing: 0,
      rotationSpeed: 64,
      intent: { kind: 'turn-to-angle', angle: 1024 },
    });

    manager.updateNpcVisualFacing([0, 0], CLIENT_CYCLE_MS);

    expect(appliedAngle(manager, 'slow')).toBe(expectedSmoothed(0, 1024, 32));
    expect(appliedAngle(manager, 'fast')).toBe(expectedSmoothed(0, 1024, 64));
    expect(appliedAngle(manager, 'slow')).not.toBe(appliedAngle(manager, 'fast'));
  });

  it('resolves a track-actor intent aimed at the PRIMARY_NPC_ACTOR_ID alias', () => {
    // Healer tracks the boss via the primary alias (post-remap); boss is to its north.
    const manager = new NpcInstanceManager();
    seed(manager, {
      actorId: 'healer',
      npcTypeId: 8050,
      position: [10, 10],
      size: 1,
      facing: 0,
      rotationSpeed: 4096,
      intent: { kind: 'track-actor', targetId: PRIMARY_NPC_ACTOR_ID },
    });
    seed(manager, {
      actorId: PRIMARY_NPC_ACTOR_ID,
      npcTypeId: PRIMARY_TYPE_ID,
      position: [8, 20],
      size: PRIMARY_SIZE,
      facing: 0,
      rotationSpeed: 32,
      intent: { kind: 'track-actor', targetId: 'player' },
    });

    manager.updateNpcVisualFacing([50, 50], CLIENT_CYCLE_MS);

    expect(appliedAngle(manager, 'healer')).toBe(bearing(10.5, 10.5, 10.5, 22.5));
  });
});

/**
 * Transparent static ownership (no void flare flicker).
 *
 * Multiple alpha-animated NPC instances of the same type (e.g. Yama void
 * flares) are all seeded with the same `typeData.unsortedTransparentStatic`
 * reference in `createInstance`. The alpha-animated branch of
 * `applyUpdatedMeshToInstance` mutates in place via `.set()` whenever
 * transparent face counts match, so writing into the shared object would let
 * sibling instances stomp on each other's transparent attrs (hslColors /
 * alphas / faceBias), showing as brief transparent flicker on multi-instance
 * spawns.
 *
 * So the in-place reuse path is refused while the instance still references
 * the shared type-level object, forcing a one-time per-instance clone.
 */
describe('NpcInstanceManager.applyUpdatedMeshToInstance — transparent static ownership', () => {
  // Simple two-triangle mesh: one opaque face (alpha=1.0) and one transparent
  // face (alpha=0.5). Gives split.transparent exactly 1 triangle so the
  // length-matching in-place reuse path can be exercised cleanly.
  function makeUpdatedMesh() {
    // 2 triangles × 3 verts × 3 floats = 18
    const positions = new Float32Array([
      // Tri 0 — opaque
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      // Tri 1 — transparent
      0, 0, 1, 1, 0, 1, 0, 1, 1,
    ]);
    const normals = new Float32Array(18);
    // Per-vertex HSL colors (1 float per vertex, 6 verts total).
    const hslColors = new Float32Array([100, 100, 100, 200, 200, 200]);
    // Per-vertex alpha. Triangle 0 opaque (1.0), triangle 1 transparent (0.5).
    const alphas = new Float32Array([1.0, 1.0, 1.0, 0.5, 0.5, 0.5]);
    const faceBias = new Float32Array([0, 0, 0, 0, 0, 0]);
    const modelFaceIndices = new Uint32Array([0, 1]);
    const faceColors3 = new Int32Array([1000, 2000]);
    return { positions, normals, hslColors, alphas, faceBias, modelFaceIndices, faceColors3 };
  }

  function makeSharedTypeStatic() {
    // Mimics typeData.unsortedTransparentStatic: the type-level buffer every
    // freshly created instance of this NPC type initially points at.
    return {
      hslColors: new Float32Array([777, 777, 777]),
      alphas: new Float32Array([0.5, 0.5, 0.5]),
      faceBias: new Float32Array([0, 0, 0]),
    };
  }

  function makeInstance(sharedStatic: ReturnType<typeof makeSharedTypeStatic>, actorId: string) {
    // Minimal instance shape: applyUpdatedMeshToInstance (alpha-animated path)
    // only touches these fields. Mesh commands need `-transparent` / `-opaque`
    // in their meshId so applySplitBuffersToCommands can find them.
    return {
      actorId,
      npcTypeId: 999,
      alphaAnimated: true,
      instanceFaceSplitMap: null,
      instanceSplitBuffers: null,
      dynamicTransparentFaceMap: null,
      dynamicTransparentStatic: sharedStatic,
      dynamicFaceAlphas: null,
      dynamicFaceColors3: null,
      instanceMeshCommands: [{ meshId: `npc-999-opaque-${actorId}` }, { meshId: `npc-999-transparent-${actorId}` }],
      transparentSortDirty: false,
    };
  }

  function makeTypeData(sharedStatic: ReturnType<typeof makeSharedTypeStatic>) {
    return {
      npcTypeId: 999,
      unsortedTransparentStatic: sharedStatic,
      modelData: {
        mergedModel: {
          faceAlphas: new Int8Array([0, 127]),
        },
      },
    };
  }

  it('does not mutate the shared type-level static attrs when one instance updates', () => {
    const sharedStatic = makeSharedTypeStatic();
    const frozenHsl = new Float32Array(sharedStatic.hslColors);
    const frozenAlphas = new Float32Array(sharedStatic.alphas);
    const frozenBias = new Float32Array(sharedStatic.faceBias);

    const manager = new NpcInstanceManager();
    const typeData = makeTypeData(sharedStatic);
    const instance = makeInstance(sharedStatic, 'flare-a');

    (manager as any).applyUpdatedMeshToInstance(instance as any, typeData as any, makeUpdatedMesh());

    // The type-level shared object must be byte-for-byte unchanged.
    expect(Array.from(sharedStatic.hslColors)).toEqual(Array.from(frozenHsl));
    expect(Array.from(sharedStatic.alphas)).toEqual(Array.from(frozenAlphas));
    expect(Array.from(sharedStatic.faceBias!)).toEqual(Array.from(frozenBias));

    // And the instance must own a distinct object after the update.
    expect(instance.dynamicTransparentStatic).not.toBe(sharedStatic);
  });

  it('gives two sibling instances distinct dynamicTransparentStatic references', () => {
    const sharedStatic = makeSharedTypeStatic();
    const manager = new NpcInstanceManager();
    const typeData = makeTypeData(sharedStatic);

    const instanceA = makeInstance(sharedStatic, 'flare-a');
    const instanceB = makeInstance(sharedStatic, 'flare-b');

    // Both siblings start out pointing at the same shared type-level object.
    expect(instanceA.dynamicTransparentStatic).toBe(sharedStatic);
    expect(instanceB.dynamicTransparentStatic).toBe(sharedStatic);

    (manager as any).applyUpdatedMeshToInstance(instanceA as any, typeData as any, makeUpdatedMesh());
    (manager as any).applyUpdatedMeshToInstance(instanceB as any, typeData as any, makeUpdatedMesh());

    // After one update each, each instance must own its own object and must
    // not share it with the sibling or the type-level original.
    expect(instanceA.dynamicTransparentStatic).not.toBe(sharedStatic);
    expect(instanceB.dynamicTransparentStatic).not.toBe(sharedStatic);
    expect(instanceA.dynamicTransparentStatic).not.toBe(instanceB.dynamicTransparentStatic);

    // And the per-attribute buffers must also be independent arrays, so a
    // later in-place .set() on one will not bleed into the other.
    const staticA = instanceA.dynamicTransparentStatic as NonNullable<typeof instanceA.dynamicTransparentStatic>;
    const staticB = instanceB.dynamicTransparentStatic as NonNullable<typeof instanceB.dynamicTransparentStatic>;
    expect(staticA.hslColors).not.toBe(staticB.hslColors);
    expect(staticA.alphas).not.toBe(staticB.alphas);
    expect(staticA.hslColors).not.toBe(sharedStatic.hslColors);
    expect(staticA.alphas).not.toBe(sharedStatic.alphas);
  });

  it('reuses the per-instance object in place on subsequent updates (fast path)', () => {
    const sharedStatic = makeSharedTypeStatic();
    const manager = new NpcInstanceManager();
    const typeData = makeTypeData(sharedStatic);
    const instance = makeInstance(sharedStatic, 'flare-a');

    // First update: must clone off the shared object.
    (manager as any).applyUpdatedMeshToInstance(instance as any, typeData as any, makeUpdatedMesh());
    const afterFirst = instance.dynamicTransparentStatic;
    expect(afterFirst).not.toBe(sharedStatic);

    // Second update with the same transparent face count: the instance now
    // owns its buffers, so the fast in-place `.set()` path must reuse the
    // exact same object rather than allocating a third one.
    (manager as any).applyUpdatedMeshToInstance(instance as any, typeData as any, makeUpdatedMesh());
    expect(instance.dynamicTransparentStatic).toBe(afterFirst);
  });
});

/**
 * Tests for encounter-agnostic smooth primary-NPC turning.
 *
 * The shared seam these tests pin — `updatePrimaryNpcVisualFacing` +
 * `getPrimaryNpcSmoothedFacingAngle` on {@link NpcInstanceManager} — keeps
 * the {@link NpcVisualTracker} smoothing logic in one renderer path for
 * encounters that remap their primary NPC to {@link PRIMARY_NPC_ACTOR_ID}.
 *
 * The concrete assertions below (`expectedTarget=1095`,
 * `expectedSmoothed=2016` for a Yama-shaped 5×5 primary NPC at [29,28] with
 * the player at visual [33,39] and the default `turnSpeed=32`) prove:
 *   - the OSRS look-at math is preserved (target = 1095),
 *   - the tracker advances by exactly one client cycle worth of rotation
 *     from the current visual angle, so the on-screen angle equals 2016
 *     (short-way `-1 × turnSpeed` from 0) — NOT 1095 (raw target) and NOT
 *     0 (raw simulation / cardinal facing).
 */

// Mirrors `src/render/core/interpolation.ts` internals — kept as local
// constants so a drift in the tracker's public contract shows up here.
// (`CLIENT_CYCLE_MS` itself comes from `npcFacingTestHarness`.)
const DEFAULT_TURN_SPEED = 32;
const ANGLE_FULL = 2048;

// Yama's real primary NPC id + footprint (see `src/encounters/yamaP3/constants.ts`
// and `YAMA_ENCOUNTER_RENDER_CONFIG`).
// `PRIMARY_TYPE_ID`, `PRIMARY_SIZE` and `PRIMARY_BASE_POS` come from `npcFacingTestHarness`.
const PRIMARY_ROTATION_SPEED = DEFAULT_TURN_SPEED;
const TYPE_REGISTRY_KEY = 'typeRegistry';
const INSTANCE_REGISTRY_KEY = 'instanceRegistry';

/**
 * OSRS look-at math from `YamaSceneCompositor.updateEncounterNpcFacing`.
 * NPC center = base + size/2 (geometric center of the footprint), player
 * center = playerVisual + 0.5, target = normalized
 * `round(atan2(-dx, -dy) * 2048/(2π))` clamped into [0, 2048).
 */
function computeLookAtAngle(
  basePosition: [number, number],
  npcSize: number,
  playerVisualPosition: [number, number],
): number {
  const [baseX, baseY] = basePosition;
  const npcCenterX = baseX + npcSize / 2;
  const npcCenterY = baseY + npcSize / 2;
  const playerRenderX = playerVisualPosition[0] + 0.5;
  const playerRenderY = playerVisualPosition[1] + 0.5;
  const facingDx = playerRenderX - npcCenterX;
  const facingDy = playerRenderY - npcCenterY;
  if (facingDx === 0 && facingDy === 0) return 0;
  const radians = Math.atan2(-facingDx, -facingDy);
  return ((Math.round(radians * (ANGLE_FULL / (2 * Math.PI))) % ANGLE_FULL) + ANGLE_FULL) % ANGLE_FULL;
}

function makeNpcModelData(npcId: number, size: number, rotationSpeed: number): NpcModelData {
  return {
    npcId,
    npcName: `Test NPC ${npcId}`,
    modelIds: [],
    models: [],
    mergedModel: null,
    litColors: null,
    lighting: { ambient: 0, contrast: 0, lightX: 0, lightY: 0, lightZ: 0 },
    size,
    widthScale: 128,
    heightScale: 128,
    rotationSpeed,
    walkSeqId: -1,
    turnLeftSeqId: -1,
    turnRightSeqId: -1,
  };
}

function makeTypeRegistryEntry(npcTypeId: number, size: number, rotationSpeed: number) {
  const modelData = makeNpcModelData(npcTypeId, size, rotationSpeed);

  return {
    npcTypeId,
    modelData,
    litColors: modelData.litColors,
    baseMeshCommands: [],
    faceSplitMap: null,
    splitBuffers: null,
    modelBounds: null,
    animationSet: null,
    restVerticesX: null,
    restVerticesY: null,
    restVerticesZ: null,
    restFaceAlphas: null,
    size,
    widthScale: modelData.widthScale,
    heightScale: modelData.heightScale,
    transparentFaceMap: null,
    alphaAnimated: false,
    unsortedTransparentStatic: null,
    bossDeathAnimationEnabled: false,
    deathDurationMs: null,
  };
}

function makeInstance(actorId: string, npcTypeId: number, modelMatrix: Float32Array) {
  const meshCommand: NpcMesh3DCommand = {
    kind: 'mesh3d',
    meshId: `npc-${npcTypeId}-body-${actorId}`,
    materialId: `npc-${npcTypeId}-material`,
    modelMatrix,
    positions: new Float32Array(),
    normals: new Float32Array(),
  };

  return {
    actorId,
    npcTypeId,
    currentModelMatrix: modelMatrix,
    instanceMeshCommands: [meshCommand],
    transparentSortDirty: false,
    animController: null,
    modelAdapter: null,
    animatedModel: null,
    originalVerticesX: null,
    originalVerticesY: null,
    originalVerticesZ: null,
    originalFaceAlphas: null,
    posedVerticesX: null,
    posedVerticesY: null,
    posedVerticesZ: null,
    instanceFaceSplitMap: null,
    instanceSplitBuffers: null,
    alphaAnimated: false,
    dynamicTransparentFaceMap: null,
    dynamicTransparentStatic: null,
    dynamicFaceAlphas: null,
    dynamicFaceColors3: null,
    lastAttackTriggerTick: -1,
    permuteSortOutputBuffers: null,
  };
}

/**
 * Build a manager already primed with a 5×5 primary NPC:
 *   - {@link NpcInstanceManager.setPrimaryNpcRenderConfig} pointed at
 *     `PRIMARY_TYPE_ID` (public API);
 *   - a type-registry entry carrying the model's `rotationSpeed` (so the
 *     shared seam has somewhere to read the type's turn speed from);
 *   - a primary-NPC instance whose `currentModelMatrix` starts at facing
 *     angle 0 — matching what `syncInstances()` would produce from a
 *     fresh simulation snapshot with `npc.facingAngle = 0`.
 */
function seedPrimaryNpc(options: { configurePrimary?: boolean; rotationSpeed?: number } = {}) {
  const configurePrimary = options.configurePrimary ?? true;
  const rotationSpeed = options.rotationSpeed ?? PRIMARY_ROTATION_SPEED;
  const manager = new NpcInstanceManager();
  if (configurePrimary) {
    manager.setPrimaryNpcRenderConfig({
      actorId: PRIMARY_NPC_ACTOR_ID,
      npcTypeId: PRIMARY_TYPE_ID,
      basePosition: PRIMARY_BASE_POS,
      size: PRIMARY_SIZE,
      deathSeqId: 1,
      deathRetentionTicks: 1,
    });
  }
  manager[TYPE_REGISTRY_KEY].set(PRIMARY_TYPE_ID, makeTypeRegistryEntry(PRIMARY_TYPE_ID, PRIMARY_SIZE, rotationSpeed));

  // Seed the primary NPC's model matrix at facing angle 0. Mirrors
  // `NpcInstanceManager.computeModelMatrixInto` for angle=0 with
  // terrainHeights=null (getLocCenterHeight returns 0):
  //   m[0]=SCALE, m[6]=-SCALE, m[9]=SCALE, m[12]=tx, m[13]=ty, m[15]=1.
  const SCALE = 1 / 128;
  const tx = PRIMARY_BASE_POS[0] + PRIMARY_SIZE / 2;
  const ty = PRIMARY_BASE_POS[1] + PRIMARY_SIZE / 2;
  const primaryModelMatrix = new Float32Array(16);
  primaryModelMatrix[0] = SCALE;
  primaryModelMatrix[6] = -SCALE;
  primaryModelMatrix[9] = SCALE;
  primaryModelMatrix[12] = tx;
  primaryModelMatrix[13] = ty;
  primaryModelMatrix[15] = 1;

  manager[INSTANCE_REGISTRY_KEY].set(
    PRIMARY_NPC_ACTOR_ID,
    makeInstance(PRIMARY_NPC_ACTOR_ID, PRIMARY_TYPE_ID, primaryModelMatrix),
  );

  return { manager, primaryModelMatrix };
}

describe('NpcInstanceManager smooth primary-NPC facing (encounter-agnostic)', () => {
  it('turns the primary NPC one client cycle toward the player, not directly to the raw target and not to raw cardinal facing', () => {
    // Given: a 5×5 primary NPC at SW-corner [29,28] with its
    // visual tracker seeded at angle 0, and a player at visual [33,39]
    // (well outside a single-step snap window from angle 0). The tracker's
    // per-cycle rotation must equal the type's `rotationSpeed`.
    const { manager, primaryModelMatrix } = seedPrimaryNpc();
    const playerVisualPos: [number, number] = [33, 39];

    // Concrete anchors for the OSRS look-at + tracker math on this fixture:
    //   NPC center = [31.5, 30.5]; player center = [33.5, 39.5]
    //   dx = 2, dy = 9; atan2(-2, -9) ≈ -2.9229 rad
    //   round(-2.9229 * 2048/(2π)) = -953 → normalized target = 1095
    //   short-way delta = 1095 - 2048 = -953 → direction = -1
    //   one-cycle step: (0 + -1 * 32) & 2047 = 2016
    const expectedTarget = computeLookAtAngle(PRIMARY_BASE_POS, PRIMARY_SIZE, playerVisualPos);
    expect(expectedTarget).toBe(1095);

    const expectedTracker = new NpcVisualTracker(0, PRIMARY_ROTATION_SPEED);
    expectedTracker.setTarget(expectedTarget);
    const expectedSmoothed = expectedTracker.advance(CLIENT_CYCLE_MS).facingAngle;
    expect(expectedSmoothed).toBe(2016);

    // When: the shared seam advances the primary NPC's visual facing by
    // exactly one client cycle (20 ms).
    manager.updatePrimaryNpcVisualFacing(playerVisualPos, CLIENT_CYCLE_MS);

    // Then: the smoothed angle exposed by the shared getter matches a
    // fresh NpcVisualTracker fed the same target + delta with the type's
    // rotationSpeed. It is NOT the raw look-at target (would mean "snap
    // straight at the player") and NOT the raw simulation cardinal 0
    // (would mean "no smoothing").
    expect(manager.getPrimaryNpcSmoothedFacingAngle()).toBe(expectedSmoothed);
    expect(manager.getPrimaryNpcSmoothedFacingAngle()).not.toBe(expectedTarget);
    expect(manager.getPrimaryNpcSmoothedFacingAngle()).not.toBe(0);

    // And: the primary NPC's model matrix rotation coefficients reflect
    // the smoothed angle. `computeModelMatrixInto` writes:
    //   m[0] =  SCALE*cos(θ), m[1] = -SCALE*sin(θ),
    //   m[8] =  SCALE*sin(θ), m[9] =  SCALE*cos(θ),
    // where θ = (angle/2048) * 2π, SCALE = 1/128.
    const SCALE = 1 / 128;
    const theta = (expectedSmoothed / ANGLE_FULL) * 2 * Math.PI;
    expect(primaryModelMatrix[0]).toBeCloseTo(SCALE * Math.cos(theta), 6);
    expect(primaryModelMatrix[1]).toBeCloseTo(-SCALE * Math.sin(theta), 6);
    expect(primaryModelMatrix[8]).toBeCloseTo(SCALE * Math.sin(theta), 6);
    expect(primaryModelMatrix[9]).toBeCloseTo(SCALE * Math.cos(theta), 6);
  });

  it('leaves secondary NPC instances untouched by the primary-facing update', () => {
    // Given: the primary NPC AND an unrelated secondary NPC instance
    // (not the primary type, not the `PRIMARY_NPC_ACTOR_ID` alias) in the
    // instance registry, its model matrix pre-frozen as a snapshot.
    const { manager } = seedPrimaryNpc();
    const secondaryTypeId = 9999;
    manager[TYPE_REGISTRY_KEY].set(secondaryTypeId, makeTypeRegistryEntry(secondaryTypeId, 1, 64));
    const secondaryModelMatrix = new Float32Array([0.5, 0, 0, 0, 0, 0, -0.5, 0, 0, 0.5, 0, 0, 10, 11, 12, 1]);
    const secondarySnapshot = new Float32Array(secondaryModelMatrix);
    manager[INSTANCE_REGISTRY_KEY].set(
      'secondary-guard-1',
      makeInstance('secondary-guard-1', secondaryTypeId, secondaryModelMatrix),
    );

    // When: the shared primary-facing update runs (drives a real
    // multi-cycle turn on the primary — see the previous test's math).
    manager.updatePrimaryNpcVisualFacing([33, 39], CLIENT_CYCLE_MS);

    // Then: the secondary instance's model matrix is byte-identical to
    // the pre-call snapshot. The shared seam must target
    // `PRIMARY_NPC_ACTOR_ID` alone; it must not touch other registry
    // entries even when they share a footprint or type.
    expect(Array.from(secondaryModelMatrix)).toEqual(Array.from(secondarySnapshot));
  });

  it('does not smooth a primary-alias NPC without an encounter primary render config', () => {
    const { manager, primaryModelMatrix } = seedPrimaryNpc({ configurePrimary: false });
    const matrixBefore = new Float32Array(primaryModelMatrix);

    const returned = manager.updatePrimaryNpcVisualFacing([33, 39], CLIENT_CYCLE_MS);

    expect(returned).toBeUndefined();
    expect(manager.getPrimaryNpcSmoothedFacingAngle()).toBeUndefined();
    expect(Array.from(primaryModelMatrix)).toEqual(Array.from(matrixBefore));
  });

  it('returns the current smoothed angle without advancing when deltaMs = 0', () => {
    // Given: the tracker has already advanced once (20 ms) toward a
    // non-trivial target, producing a non-zero smoothed angle and a
    // matching model matrix snapshot.
    const { manager, primaryModelMatrix } = seedPrimaryNpc();
    const playerVisualPos: [number, number] = [33, 39];

    manager.updatePrimaryNpcVisualFacing(playerVisualPos, CLIENT_CYCLE_MS);
    const angleAfterFirst = manager.getPrimaryNpcSmoothedFacingAngle();
    // Sanity: the pre-call state is the mid-turn 2016 pinned above — a
    // "no-op" of 0 or 1095 would sneak through the next assertions
    // otherwise.
    expect(angleAfterFirst).toBe(2016);
    const matrixAfterFirst = new Float32Array(primaryModelMatrix);

    // When: the shared update is called with deltaMs = 0 and the same
    // player position (target unchanged). NpcVisualTracker.advance(<=0)
    // is a documented no-op that just rebuilds the current state.
    const returned = manager.updatePrimaryNpcVisualFacing(playerVisualPos, 0);

    // Then: the smoothed angle is exactly what it was — no further
    // rotation, no drift back toward 0 or forward toward the raw target.
    expect(manager.getPrimaryNpcSmoothedFacingAngle()).toBe(angleAfterFirst);
    expect(returned).toBe(angleAfterFirst);

    // And: the primary NPC's model matrix is byte-identical to the
    // pre-call snapshot. deltaMs=0 must not budge the visual state, even
    // if the implementation re-writes the matrix as a defensive no-op —
    // `computeModelMatrixInto` is deterministic for the same angle.
    expect(Array.from(primaryModelMatrix)).toEqual(Array.from(matrixAfterFirst));
  });
});

describe('NpcInstanceManager depth-enabled transparent ordering', () => {
  const cacheInfo = {
    name: 'osrs-test',
    game: 'oldschool',
    environment: 'live',
    revision: 232,
    timestamp: '',
    size: 0,
  } as const;
  const camera = { cameraX: 0, cameraY: 0, cameraZ: -1000, yawSin: 0, yawCos: 1, pitchSin: 0, pitchCos: 1 };

  function spawn(manager: NpcInstanceManager, npcTypeId: number, id: string) {
    const snapshot = makeSnapshot({ id, npcTypeId, position: [0, 0], size: 1 });
    return manager['createInstance'](snapshot, manager['typeRegistry'].get(npcTypeId)!);
  }

  function triangleKey(mesh: NpcMeshData, triangle: number): string {
    return [
      ...mesh.positions.subarray(triangle * 9, triangle * 9 + 9),
      ...mesh.normals.subarray(triangle * 9, triangle * 9 + 9),
      ...mesh.hslColors.subarray(triangle * 3, triangle * 3 + 3),
      ...mesh.alphas.subarray(triangle * 3, triangle * 3 + 3),
      ...(mesh.faceBias?.subarray(triangle * 3, triangle * 3 + 3) ?? [0, 0, 0]),
    ].join(',');
  }

  function assertSortedMesh(manager: NpcInstanceManager, id: string, source: NpcMeshData): number[] {
    manager.setSorterProjection(camera);
    manager.updateTransparentSort();
    const instance = manager['instanceRegistry'].get(id)!;
    const opaque = instance.instanceMeshCommands.find((command) => command.meshId.includes('-opaque'))!;
    const transparent = instance.instanceMeshCommands.find((command) => command.meshId.includes('-transparent'))!;
    expect(opaque).toMatchObject({ depth: 'readwrite', cullFace: 'back' });
    expect(transparent).toMatchObject({ depth: 'read', blend: 'normal', cullFace: 'back' });
    expect(opaque.blend).toBeUndefined();

    const sources = new Map<string, number>();
    const depths = new Map<number, number>();
    const visible = new Set<number>();
    const matrix = instance.currentModelMatrix;
    const originDepth = matrix[13] * 128 - camera.cameraZ;
    for (let triangle = 0; triangle < source.modelFaceIndices.length; triangle++) {
      const face = source.modelFaceIndices[triangle];
      sources.set(triangleKey(source, triangle), face);
      if (source.alphas[triangle * 3] >= 0.999) continue;
      const projected = [0, 1, 2].map((vertex) => {
        const offset = triangle * 9 + vertex * 3;
        const depth = source.positions[offset + 2] + originDepth;
        return {
          x: (source.positions[offset] + matrix[12] * 128) / depth,
          y: (source.positions[offset + 1] - matrix[14] * 128) / depth,
          distance: Math.trunc(depth) - Math.trunc(originDepth),
        };
      });
      const [a, b, c] = projected;
      const area = (a.x - b.x) * (c.y - b.y) - (c.x - b.x) * (a.y - b.y);
      if (area <= 0) continue;
      visible.add(face);
      depths.set(face, Math.trunc((a.distance + b.distance + c.distance) / 3));
    }
    const output: NpcMeshData = {
      positions: transparent.positions!,
      normals: transparent.normals!,
      hslColors: transparent.perVertexHslColors!,
      alphas: transparent.perVertexAlphas!,
      faceBias: transparent.perVertexFaceBias!,
      modelFaceIndices: new Uint32Array(),
    };
    const faces: number[] = [];
    for (let triangle = 0; triangle < output.positions.length / 9; triangle++) {
      const face = sources.get(triangleKey(output, triangle));
      // Matching all attributes also verifies that permutation never pairs a face with
      // another triangle's color, opacity, normal or bias.
      expect(face).toBeDefined();
      faces.push(face!);
    }
    expect(faces.length).toBe(visible.size);
    expect(new Set(faces)).toEqual(visible);
    const buckets = faces.map((face) => depths.get(face)!);
    expect(buckets).toEqual([...buckets].sort((left, right) => right - left));
    return faces;
  }

  async function synthetic(config: NpcTypeLoadConfig = {}, primary = false) {
    const model = new ModelData();
    model.verticesCount = model.usedVertexCount = 12;
    model.faceCount = 4;
    model.verticesX = new Int32Array([-40, -40, 40, -40, -40, 40, -40, -40, 40, -40, -40, 40]);
    model.verticesY = new Int32Array([-40, 40, -40, -40, 40, -40, -40, 40, -40, -40, 40, -40]);
    model.verticesZ = new Int32Array([0, 0, 0, 200, 200, 200, 100, 100, 100, 50, 50, 50]);
    model.indices1 = new Int32Array([0, 3, 6, 9]);
    model.indices2 = new Int32Array([1, 4, 7, 10]);
    model.indices3 = new Int32Array([2, 5, 8, 11]);
    model.faceColors = new Uint16Array([1000, 2000, 3000, 4000]);
    model.faceAlphas = new Int8Array([64, 128, 192, 0]);
    model.faceRenderPriorities = new Int8Array([0, 4, 10, 2]);
    model.faceBias = new Int8Array([1, 2, 3, 4]);
    const npc = new NpcType(999, cacheInfo);
    npc.modelIds = [1];
    const npcTypeLoader: NpcTypeLoader = { load: () => npc, getCount: () => 1, clearCache: () => {} };
    const loader = new NpcModelLoader(npcTypeLoader, { getModel: () => model });
    const manager = new NpcInstanceManager();
    if (primary) {
      manager.setPrimaryNpcRenderConfig({
        actorId: PRIMARY_NPC_ACTOR_ID,
        npcTypeId: 999,
        basePosition: [0, 0],
        size: 1,
        deathSeqId: -1,
      });
    }
    await manager.loadNpcType(999, loader, undefined, config);
    const type = manager['typeRegistry'].get(999)!;
    return { manager, model, type, source: modelDataToMesh(model, type.litColors!) };
  }

  it('draws overlapping translucent faces far-to-near despite conflicting priorities', async () => {
    const { manager, source } = await synthetic();
    manager['instanceRegistry'].set('static', spawn(manager, 999, 'static'));
    expect(assertSortedMesh(manager, 'static', source)).toEqual([1, 2, 0]);
  });

  it.each([
    false,
    true,
  ])('resolves relative transparent bias once for base/instance commands (primary=%s)', async (primary) => {
    const baseline = await synthetic();
    const offset = (8 * 2) / (2 ** 24 - 1);
    const cases: { config: NpcTypeLoadConfig; expected: [number | undefined, number | undefined] }[] = [
      { config: {}, expected: [undefined, undefined] },
      { config: { depthBias: 0.0005 }, expected: [0.0005, 0.0005] },
      { config: { transparentDepthBiasOffset: offset }, expected: [undefined, offset] },
      { config: { depthBias: 0.0005, transparentDepthBiasOffset: offset }, expected: [0.0005, 0.0005 + offset] },
      { config: { depthBias: 0 }, expected: [0, 0] },
      { config: { transparentDepthBiasOffset: 0 }, expected: [undefined, 0] },
    ];
    for (const { config, expected } of cases) {
      const { manager, type, source } = await synthetic(config, primary);
      expect(type.baseMeshCommands.map((command) => command.depthBias)).toEqual(expected);
      // Command-level depth separation must not move vertices or rewrite decoded face bias.
      expect(source).toEqual(baseline.source);
      for (let part = 0; part < type.baseMeshCommands.length; part++) {
        const command = type.baseMeshCommands[part];
        const original = baseline.type.baseMeshCommands[part];
        expect(command.positions).toEqual(original.positions);
        expect(command.perVertexFaceBias).toEqual(original.perVertexFaceBias);
        expect(command.perVertexAlphas).toEqual(original.perVertexAlphas);
        expect([command.depth, command.cullFace, command.blend]).toEqual([
          original.depth,
          original.cullFace,
          original.blend,
        ]);
      }
      const id = primary ? PRIMARY_NPC_ACTOR_ID : 'biased';
      const snapshot = makeSnapshot({ id, npcTypeId: 999, size: 1, position: [0, 0] });
      for (let sync = 0; sync < 3; sync++) {
        manager.syncInstances([snapshot]);
        const instance = manager['instanceRegistry'].get(id)!;
        expect(instance.instanceMeshCommands.map((command) => command.depthBias)).toEqual(expected);
        expect(assertSortedMesh(manager, id, source)).toEqual([1, 2, 0]);
        expect(manager.getHitTestData(id)).not.toBeNull();
        expect(manager.getHitTestData(id)?.depthBias).toBe(config.depthBias);
      }
    }
  });

  it.each([
    false,
    true,
  ])('retains distinct biases through alpha updates, sync and retained death (primary=%s)', async (primary) => {
    const base = 0.0005;
    const offset = (8 * 2) / (2 ** 24 - 1);
    const { manager, model, type, source } = await synthetic(
      {
        depthBias: base,
        transparentDepthBiasOffset: offset,
        deathDurationMs: 1800,
      },
      primary,
    );
    const id = primary ? PRIMARY_NPC_ACTOR_ID : 'retained';
    const snapshot = makeSnapshot({ id, npcTypeId: 999, size: 1, position: [0, 0] });
    manager.syncInstances([snapshot]);
    const instance = manager['instanceRegistry'].get(id)!;
    instance.alphaAnimated = true;
    model.faceAlphas.set([64, 0, 192, 32]);
    const updated = manager['buildAnimatedMesh'](type.modelData!, true, null)!;
    expect(updated.positions).toEqual(source.positions);
    expect(updated.faceBias).toEqual(source.faceBias);
    manager['applyUpdatedMeshToInstance'](instance, type, updated);
    manager.syncInstances([snapshot]);
    expect(assertSortedMesh(manager, id, updated)).toEqual([2, 3, 0]);
    expect(instance.instanceMeshCommands.map((command) => command.depthBias)).toEqual([base, base + offset]);

    manager.syncInstances([{ ...snapshot, alive: false }]);
    const dying = manager['dyingInstances'].get(id)!;
    expect(dying.instance).toBe(instance);
    expect(manager.getHitTestData(id)?.depthBias).toBe(base);
    manager.updateAnimations(300, 1, []);
    manager.syncInstances([]);
    expect(
      manager['dyingInstances'].get(id)?.instance.instanceMeshCommands.map((command) => command.depthBias),
    ).toEqual([base, base + offset]);
    // Dying animation updates use the same alpha split path and must also retain command policy.
    model.faceAlphas.set([32, 64, 0, 128]);
    const dyingMesh = manager['buildAnimatedMesh'](type.modelData!, true, null)!;
    manager['applyUpdatedMeshToInstance'](dying.instance, type, dyingMesh);
    manager.updateTransparentSort();
    expect(dying.instance.instanceMeshCommands.map((command) => command.depthBias)).toEqual([base, base + offset]);
    expect(dying.instance.instanceMeshCommands[0]).toMatchObject({ depth: 'readwrite', cullFace: 'back' });
    expect(dying.instance.instanceMeshCommands[1]).toMatchObject({ depth: 'read', cullFace: 'back', blend: 'normal' });
    expect(dying.instance.instanceSplitBuffers!.opaquePositions).toHaveLength(9);
    expect(manager.getHitTestData(id)?.depthBias).toBe(base);
  });

  it('updates pass membership when alpha crosses the opaque boundary without disturbing remaining depth order', async () => {
    const { manager, model, type, source } = await synthetic();
    const instance = spawn(manager, 999, 'animated');
    instance.alphaAnimated = true;
    manager['instanceRegistry'].set('animated', instance);
    manager['applyUpdatedMeshToInstance'](instance, type, manager['buildAnimatedMesh'](type.modelData!, true, null)!);
    expect(assertSortedMesh(manager, 'animated', source)).toEqual([1, 2, 0]);

    model.faceAlphas.set([64, 0, 192, 32]);
    const updated = manager['buildAnimatedMesh'](type.modelData!, true, null)!;
    manager['applyUpdatedMeshToInstance'](instance, type, updated);
    expect(assertSortedMesh(manager, 'animated', updated)).toEqual([2, 3, 0]);
    expect(instance.instanceSplitBuffers!.opaquePositions).toHaveLength(9);
    expect(Array.from(instance.dynamicTransparentFaceMap!.triToModelFace)).toEqual([0, 2, 3]);
  });

  it.each([
    false,
    true,
  ])('keeps sorted geometry and attributes instance-owned (alphaAnimated=%s)', async (alphaAnimated) => {
    const { manager, model, type, source } = await synthetic();
    const originalStatic = type.unsortedTransparentStatic!.hslColors.slice();
    const a = spawn(manager, 999, 'a');
    const b = spawn(manager, 999, 'b');
    a.alphaAnimated = b.alphaAnimated = alphaAnimated;
    manager['instanceRegistry'].set('a', a);
    manager['instanceRegistry'].set('b', b);
    if (alphaAnimated) {
      const mesh = manager['buildAnimatedMesh'](type.modelData!, true, null)!;
      manager['applyUpdatedMeshToInstance'](a, type, mesh);
      manager['applyUpdatedMeshToInstance'](b, type, mesh);
    }
    assertSortedMesh(manager, 'a', source);
    assertSortedMesh(manager, 'b', source);
    const commandA = a.instanceMeshCommands.find((command) => command.meshId.includes('-transparent'))!;
    const commandB = b.instanceMeshCommands.find((command) => command.meshId.includes('-transparent'))!;
    expect(commandA.positions!.buffer).not.toBe(commandB.positions!.buffer);
    expect(commandA.perVertexAlphas!.buffer).not.toBe(commandB.perVertexAlphas!.buffer);
    const frozenB = commandB.perVertexAlphas!.slice();
    if (alphaAnimated) {
      model.faceAlphas[0] = 96;
      const mesh = manager['buildAnimatedMesh'](type.modelData!, true, null)!;
      manager['applyUpdatedMeshToInstance'](a, type, mesh);
      assertSortedMesh(manager, 'a', mesh);
      expect(a.dynamicTransparentStatic).not.toBe(b.dynamicTransparentStatic);
    } else {
      a.transparentSortDirty = true;
      manager.updateTransparentSort();
    }
    expect(commandB.perVertexAlphas).toEqual(frozenB);
    expect(type.unsortedTransparentStatic!.hslColors).toEqual(originalStatic);
  });

  const cachePath = findProjectCacheZip('pinned') ?? '';

  describe.skipIf(skipWithoutRealCache('pinned'))('real-cache posed geometry', () => {
    let loader: NpcModelLoader;
    let animation: AnimationSystem;
    beforeAll(async () => {
      await Bzip2.initWasm();
      const files = await readCacheZipFiles(cachePath);
      const cache = CacheSystem.fromMap('dat2', files, [0, 1, 2, 7]);
      loader = new NpcModelLoader(
        new ArchiveNpcTypeLoader(cacheInfo, cache.getIndex(2).getArchive(9)),
        new IndexModelLoader(cache.getIndex(7)),
      );
      animation = new AnimationSystem();
      animation.initialize(cacheInfo, cache.getIndex(0), cache.getIndex(1), cache.getIndex(2).getArchive(12));
    }, REAL_CACHE_TEST_TIMEOUT_MS);

    it.each([
      { npcId: 12826, seqId: 10817, frames: [20, 40], crosses: false },
      { npcId: 12825, seqId: 10827, frames: [10, 11, 12, 15], crosses: true },
      { npcId: 12825, seqId: 10828, frames: [0, 1, 2, 23, 27], crosses: true },
    ])(
      'sorts NPC $npcId sequence $seqId by posed depth and current alpha membership',
      async ({ npcId, seqId, frames, crosses }) => {
        const manager = new NpcInstanceManager();
        await manager.loadNpcType(npcId, loader, animation, {
          idleSeqId: npcId === 12826 ? 10817 : 10827,
          walkSeqId: -1,
          ...(npcId === 12825 ? { attackClips: { attack: 10828 } } : {}),
        });
        const instance = spawn(manager, npcId, 'posed');
        manager['instanceRegistry'].set('posed', instance);
        expect(instance.alphaAnimated).toBe(true);
        expect(instance.modelAdapter).not.toBeNull();
        const type = manager['typeRegistry'].get(npcId)!;
        const sequence = animation.loadSeqType(seqId)!;
        const opaqueCounts = new Set<number>();
        for (const frame of frames) {
          instance.modelAdapter!.resetPose();
          instance.modelAdapter!.applyFrame(sequence.frameIds[frame]);
          instance.modelAdapter!.commitPose();
          const mesh = manager['buildAnimatedMesh'](type.modelData!, true, null)!;
          expect(assertSortedMesh(manager, 'posed', mesh).length).toBeGreaterThan(0);
          opaqueCounts.add(instance.instanceSplitBuffers!.opaquePositions.length / 9);
        }
        if (crosses) expect(opaqueCounts.size).toBeGreaterThan(1);
        else expect([...opaqueCounts]).toEqual([0]);
      },
      REAL_CACHE_TEST_TIMEOUT_MS,
    );

    it(
      'plays the idle-less Inferno pillar collapse (NPC 7710, seq 7561) from its spawn tick and holds the rubble',
      async () => {
        const manager = new NpcInstanceManager();
        await manager.loadNpcType(7710, loader, animation, { spawnSeqId: 7561 });
        const type = manager['typeRegistry'].get(7710)!;
        expect(loader.loadNpcType(7710)?.idleSeqId).toBe(-1);
        expect(type.animationSet?.idle).toBeUndefined();
        expect(type.animationSet?.spawn?.seqId).toBe(7561);
        expect(type.baseMeshCommands.every((command) => command.animated)).toBe(true);

        const spawnTick = 100;
        const collapse = {
          ...makeSnapshot({ id: 'collapse', npcTypeId: 7710, position: [10, 10], size: 3 }),
          spawnTick,
        };
        const meanHeight = (actorId: string) => {
          const instance = manager['instanceRegistry'].get(actorId)!;
          const heights = instance.posedVerticesY ?? instance.originalVerticesY!;
          return heights.reduce((sum, y) => sum + y, 0) / heights.length;
        };
        const pose = (actorId: string) => manager['instanceRegistry'].get(actorId)?.animController?.getFrameState();
        const duration = (type.animationSet!.spawn as FrameClipRef).frameLengths.reduce(
          (sum, length) => sum + length,
          0,
        );

        manager.syncInstances([collapse], 0, spawnTick * 30, spawnTick);
        const standing = meanHeight('collapse');
        manager.updateAnimations(0, 1, []);
        expect(pose('collapse')).toMatchObject({ seqId: 7561, currentFrameIndex: 0 });
        // Model Y grows downward: the collapse brings the pillar's mass down to the floor.
        for (let cycle = 0; cycle < duration + 30; cycle++) manager.updateAnimations(CLIENT_TICK_MS, 1, []);
        const lastFrame = (type.animationSet!.spawn as FrameClipRef).frameIds.length - 1;
        expect(pose('collapse')).toMatchObject({ seqId: 7561, currentFrameIndex: lastFrame });
        const rubble = meanHeight('collapse');
        expect(rubble - standing).toBeGreaterThan(100);

        // First observed mid-collapse (a seek, or a late first frame): sampled from the spawn tick.
        manager.syncInstances([{ ...collapse, id: 'late' }], 0, spawnTick * 30 + 20, spawnTick);
        manager.updateAnimations(0, 1, []);
        const live = new NpcInstanceManager();
        await live.loadNpcType(7710, loader, animation, { spawnSeqId: 7561 });
        live.syncInstances([collapse], 0, spawnTick * 30, spawnTick);
        for (let cycle = 0; cycle <= 20; cycle++) live.updateAnimations(cycle === 0 ? 0 : CLIENT_TICK_MS, 1, []);
        expect(pose('late')).toEqual(live['instanceRegistry'].get('collapse')?.animController?.getFrameState());

        // First observed after it ended: the held rubble, not the standing model or a restart.
        manager.syncInstances([collapse, { ...collapse, id: 'after' }], 0, spawnTick * 30 + duration + 15, spawnTick);
        manager.updateAnimations(0, 1, []);
        expect(pose('after')).toMatchObject({ seqId: 7561, currentFrameIndex: lastFrame });
        expect(meanHeight('after')).toBeCloseTo(rubble);
      },
      REAL_CACHE_TEST_TIMEOUT_MS,
    );
  });
});

describe('NpcInstanceManager animated mesh scratch', () => {
  const cacheInfo = {
    name: 'osrs-test',
    game: 'oldschool',
    environment: 'live',
    revision: 232,
    timestamp: '',
    size: 0,
  } as const;

  afterEach(() => {
    sharedModelTextureIndex.setMapper(null);
  });

  /** `faceCount` separate triangles; every fourth translucent, every third textured when `textured`. */
  function buildModel(faceCount: number, textured: boolean, seed: number): ModelData {
    const model = new ModelData();
    model.verticesCount = model.usedVertexCount = faceCount * 3;
    model.faceCount = faceCount;
    const coordinate = (vertex: number, axis: number) => ((vertex * 37 + axis * 101 + seed * 13) % 400) - 200;
    model.verticesX = Int32Array.from({ length: faceCount * 3 }, (_, vertex) => coordinate(vertex, 0));
    model.verticesY = Int32Array.from({ length: faceCount * 3 }, (_, vertex) => coordinate(vertex, 1));
    model.verticesZ = Int32Array.from({ length: faceCount * 3 }, (_, vertex) => coordinate(vertex, 2));
    model.indices1 = Int32Array.from({ length: faceCount }, (_, face) => face * 3);
    model.indices2 = Int32Array.from({ length: faceCount }, (_, face) => face * 3 + 1);
    model.indices3 = Int32Array.from({ length: faceCount }, (_, face) => face * 3 + 2);
    model.faceColors = Uint16Array.from({ length: faceCount }, (_, face) => 1000 + face * 7 + seed);
    model.faceAlphas = Int8Array.from({ length: faceCount }, (_, face) => (face % 4 === 0 ? 96 : 0));
    model.faceRenderPriorities = new Int8Array(faceCount);
    model.faceBias = Int8Array.from({ length: faceCount }, (_, face) => face % 3);
    if (textured) {
      model.faceTextures = Int16Array.from({ length: faceCount }, (_, face) => (face % 3 === 0 ? 5 + (face % 2) : -1));
      model.textureCoords = new Int8Array(faceCount).fill(-1);
    }
    return model;
  }

  async function load(manager: NpcInstanceManager, npcTypeId: number, model: ModelData) {
    const npc = new NpcType(npcTypeId, cacheInfo);
    npc.modelIds = [npcTypeId];
    const npcTypeLoader: NpcTypeLoader = { load: () => npc, getCount: () => 1, clearCache: () => {} };
    await manager.loadNpcType(npcTypeId, new NpcModelLoader(npcTypeLoader, { getModel: () => model }));
    const type = manager['typeRegistry'].get(npcTypeId)!;
    const expected = modelDataToMesh(model, type.litColors!, { resolveTextureLayer: sharedModelTextureIndex.resolve });
    return { type, expected };
  }

  function spawn(manager: NpcInstanceManager, npcTypeId: number, id: string) {
    const instance = manager['createInstance'](
      makeSnapshot({ id, npcTypeId, position: [0, 0], size: 1 }),
      manager['typeRegistry'].get(npcTypeId)!,
    );
    manager['instanceRegistry'].set(id, instance);
    return instance;
  }

  function contents(mesh: {
    positions: Float32Array;
    hslColors: Float32Array;
    alphas: Float32Array;
    faceBias: Float32Array;
    modelFaceIndices: Uint32Array;
    uvs?: Float32Array;
    textureIds?: Float32Array;
  }) {
    return {
      positions: Array.from(mesh.positions),
      hslColors: Array.from(mesh.hslColors),
      alphas: Array.from(mesh.alphas),
      faceBias: Array.from(mesh.faceBias),
      modelFaceIndices: Array.from(mesh.modelFaceIndices),
      uvs: mesh.uvs && Array.from(mesh.uvs),
      textureIds: mesh.textureIds && Array.from(mesh.textureIds),
    };
  }

  it('alternates large textured and small untextured builds with exact contents and no scratch reallocation', async () => {
    sharedModelTextureIndex.setMapper((textureId) => textureId + 1);
    const manager = new NpcInstanceManager();
    const large = await load(manager, 501, buildModel(24, true, 1));
    const small = await load(manager, 502, buildModel(5, false, 2));
    const build = (type: typeof large.type) => manager['buildAnimatedMesh'](type.modelData!, true, null)!;

    // Warm-up: the first large textured build sizes the scratch and its texture arrays.
    build(large.type);
    build(small.type);
    const scratch = manager['animMeshScratch']!;
    const backing = [scratch.positions, scratch.hslColors, scratch.uvs!, scratch.textureIds!].map((a) => a.buffer);

    for (let round = 0; round < 3; round++) {
      for (const { type, expected } of [large, small, small, large]) {
        const mesh = build(type);
        expect(contents(mesh)).toEqual(contents(expected));
        // Exact used-range views: stale capacity is never handed downstream.
        expect(mesh.positions.length).toBe(expected.positions.length);
        expect(mesh.normals.length).toBe(expected.positions.length);
      }
    }
    expect(large.expected.textureIds?.some((layer) => layer > 0)).toBe(true);
    expect(small.expected.uvs).toBeUndefined();
    const after = manager['animMeshScratch']!;
    expect(after).toBe(scratch);
    expect([after.positions, after.hslColors, after.uvs!, after.textureIds!].map((a) => a.buffer)).toEqual(backing);
  });

  it('keeps each instance mesh intact after the scratch is reused for another type', async () => {
    const manager = new NpcInstanceManager();
    const large = await load(manager, 511, buildModel(16, false, 3));
    const small = await load(manager, 512, buildModel(4, false, 4));
    const a = spawn(manager, 511, 'a');
    const b = spawn(manager, 512, 'b');
    const opaqueOf = (instance: typeof a) =>
      instance.instanceMeshCommands.find((cmd) => cmd.meshId.includes('-opaque'))!;

    manager['applyUpdatedMeshToInstance'](
      a,
      large.type,
      manager['buildAnimatedMesh'](large.type.modelData!, true, null)!,
    );
    const opaqueA = Array.from(opaqueOf(a).positions);
    manager['applyUpdatedMeshToInstance'](
      b,
      small.type,
      manager['buildAnimatedMesh'](small.type.modelData!, true, null)!,
    );

    expect(Array.from(opaqueOf(a).positions)).toEqual(opaqueA);
    expect(opaqueOf(a).positions.buffer).not.toBe(manager['animMeshScratch']!.positions.buffer);
    expect(opaqueA).toEqual(Array.from(large.type.baseMeshCommands[0].positions));
    expect(Array.from(opaqueOf(b).positions)).toEqual(Array.from(small.type.baseMeshCommands[0].positions));
  });
});

describe('NpcInstanceManager hidden and transforming NPCs', () => {
  it('draws no instance for a hidden NPC, and builds a fresh one when it shows again', () => {
    const manager = new NpcInstanceManager();
    registerType(manager, 9000, 1, 32);
    const npc = makeSnapshot({ id: 'mob', npcTypeId: 9000, position: [12, 14], size: 1 });
    manager.syncInstances([npc], 1);
    const first = manager['instanceRegistry'].get('mob');
    expect(first).toBeDefined();
    manager.syncInstances([{ ...npc, hidden: true }], 1);
    expect(manager['instanceRegistry'].has('mob')).toBe(false);
    manager.syncInstances([npc], 1);
    const shown = manager['instanceRegistry'].get('mob');
    expect(shown).toBeDefined();
    expect(shown).not.toBe(first);
  });

  it('rebuilds the instance when the same actor changes type', () => {
    const manager = new NpcInstanceManager();
    registerType(manager, 9000, 1, 32);
    registerType(manager, 9001, 1, 32);
    const npc = makeSnapshot({ id: 'mob', npcTypeId: 9000, position: [12, 14], size: 1 });
    manager.syncInstances([npc], 1);
    manager.syncInstances([{ ...npc, npcTypeId: 9001 }], 1);
    expect(manager['instanceRegistry'].get('mob')?.npcTypeId).toBe(9001);
  });
});
