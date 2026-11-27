/**
 * What an encounter scene shows, read from its render queue and its NPC poses rather than from the
 * controllers that produce it, so the same assertions hold however presentation is owned.
 *
 * Assets are synthetic: every NPC type is one triangle with three-frame clips of 2, 3 and 5 cycles,
 * and every spot animation three 20-cycle frames whose mesh ids name the effect and frame.
 */
import { vi } from 'vitest';
import type { ReplayDisplayFrame } from '../../core/ReplayRecorder';
import { AnimationSystem } from '../../render/backends/picogl/AnimationSystem';
import type { Projection2D } from '../../render/core/camera';
import type { RenderQueue } from '../../render/core/commands';
import { PRIMARY_NPC_ACTOR_ID } from '../../render/npc/NpcInstanceManager';
import type { SceneCompositor } from '../../render/scene/SceneCompositor';
import type { RenderContext } from '../../render/scene/types';
import { NpcType } from '../../rs/config/npctype/NpcType';
import { SeqType } from '../../rs/config/seqtype/SeqType';
import { ModelData } from '../../rs/model/ModelData';
import { NpcModelLoader } from '../../rs/model/NpcModelLoader';

const CACHE_INFO = {
  name: 'test',
  game: 'oldschool',
  environment: 'live',
  revision: 232,
  timestamp: '',
  size: 0,
} as const;

export const SCENE_OPTIONS: RenderContext['options'] = {
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
};

export const IDENTITY_PROJECTION: Projection2D = {
  tileToScreen: (tile) => tile,
  tileDeltaToScreen: (tile) => tile,
  screenToTile: () => null,
  tilePolygonScreen: (tile) => [tile, tile, tile, tile],
};

export const VIEWPORT = { width: 800, height: 600, dpr: 1 } as const;

/** Cycles per frame of every synthetic NPC clip: it lasts 10 cycles. */
export const SYNTHETIC_CLIP_FRAME_CYCLES = [2, 3, 5] as const;
/** Cycles per frame of every synthetic spot animation: it lasts 60 cycles. */
export const SYNTHETIC_GRAPHIC_FRAME_CYCLES = [20, 20, 20] as const;

export function syntheticNpcAssets(sizeOf: (npcTypeId: number) => number = () => 1) {
  const loader = new NpcModelLoader(
    {
      load: (id) => {
        const type = new NpcType(id, CACHE_INFO);
        type.modelIds = [id];
        type.size = sizeOf(id);
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
    const sequence = new SeqType(id, CACHE_INFO);
    sequence.frameIds = [10, 11, 12];
    sequence.frameLengths = [...SYNTHETIC_CLIP_FRAME_CYCLES];
    return sequence;
  });
  return { loader, animation };
}

/** Marks `spotAnimIds` loaded with three-frame meshes named `effect-<id>-f<frame>`. */
export function installSyntheticSpotAnims(scene: SceneCompositor, spotAnimIds: readonly number[]): void {
  for (const spotAnimId of spotAnimIds) {
    const mesh = (frame: number) => ({
      meshId: `effect-${spotAnimId}-f${frame}`,
      materialId: 'osrs-npc',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
      depth: 'readwrite' as const,
    });
    scene['spotAnimRenderer']['meshCache'].set(spotAnimId, {
      static: [mesh(0)],
      frames: SYNTHETIC_GRAPHIC_FRAME_CYCLES.map((_, frame) => [mesh(frame)]),
      frameLengths: [...SYNTHETIC_GRAPHIC_FRAME_CYCLES],
      frameStep: -1,
      heightOffset: 0,
    });
  }
}

export type ScenePose = { readonly seqId: number; readonly frame: number };
export type SceneEffect = {
  readonly spotAnimId: number;
  readonly frame: number;
  readonly at: readonly [number, number, number];
};
export type SceneObservation = {
  /** Each drawn or dying NPC's sequence and frame, by render id. */
  readonly poses: Readonly<Record<string, ScenePose>>;
  /** Every drawn spot animation (flights and graphics), sorted. */
  readonly effects: readonly SceneEffect[];
  /** NPC render ids with a drawn mesh, sorted. */
  readonly drawnNpcs: readonly string[];
};

const round = (value: number) => Math.round(value * 1e4) / 1e4 + 0;

export function observeScene(scene: SceneCompositor, queue: RenderQueue): SceneObservation {
  const poses: Record<string, ScenePose> = {};
  for (const state of scene['collectActorFrameStates']()) {
    if (state.actorId === 'player' || state.actorId.startsWith('spotanim:')) continue;
    poses[state.actorId] = { seqId: state.seqId, frame: state.currentFrame };
  }
  const effects: SceneEffect[] = [];
  const drawnNpcs = new Set<string>();
  for (const command of queue.commands) {
    if (command.kind !== 'mesh3d') continue;
    const effect = /^effect-(\d+)-f(\d+)$/.exec(command.meshId);
    if (effect) {
      const m = command.modelMatrix;
      effects.push({
        spotAnimId: Number(effect[1]),
        frame: Number(effect[2]),
        at: [round(m[12]), round(m[13]), round(m[14])],
      });
      continue;
    }
    // The primary NPC's mesh carries no actor suffix.
    const npc = /^npc-\d+-opaque(?:-(.+))?$/.exec(command.meshId);
    if (npc) drawnNpcs.add(npc[1] ?? PRIMARY_NPC_ACTOR_ID);
  }
  effects.sort(
    (left, right) =>
      left.spotAnimId - right.spotAnimId ||
      left.at[0] - right.at[0] ||
      left.at[1] - right.at[1] ||
      left.at[2] - right.at[2],
  );
  return { poses, effects, drawnNpcs: [...drawnNpcs].sort() };
}

/** First and last cycle (inclusive) on which each key was observed; keys must show contiguously. */
export type ActiveWindows = Readonly<Record<string, readonly [number, number]>>;

/**
 * Observes every cycle from `from` to `to` and returns the active window of each spot animation
 * (keyed by id) and of each NPC sequence (keyed `actor:seq`), skipping `ignoredSeqIds` (idles).
 */
export function activeWindows(
  observe: (cycle: number) => SceneObservation,
  from: number,
  to: number,
  ignoredSeqIds: ReadonlySet<number> = new Set(),
): { readonly effects: ActiveWindows; readonly clips: ActiveWindows } {
  const effects: Record<string, [number, number]> = {};
  const clips: Record<string, [number, number]> = {};
  const extend = (windows: Record<string, [number, number]>, key: string, cycle: number) => {
    const window = windows[key];
    if (!window) windows[key] = [cycle, cycle];
    else if (window[1] === cycle - 1) window[1] = cycle;
    else throw new Error(`${key} is not contiguous: ${window} then ${cycle}`);
  };
  for (let cycle = from; cycle <= to; cycle++) {
    const observation = observe(cycle);
    for (const spotAnimId of new Set(observation.effects.map((effect) => effect.spotAnimId)))
      extend(effects, String(spotAnimId), cycle);
    for (const [actorId, pose] of Object.entries(observation.poses))
      if (!ignoredSeqIds.has(pose.seqId)) extend(clips, `${actorId}:${pose.seqId}`, cycle);
  }
  return { effects, clips };
}

/**
 * A replay viewport's context at `cycle`: the frame whose tick contains it, that frame's events and
 * the replay clock. Frame index equals tick in every legacy recording.
 */
export function replayContextAt(
  frames: readonly ReplayDisplayFrame[],
  cycle: number,
  paused: boolean,
): Pick<RenderContext, 'simulationState' | 'events' | 'interpolatedTick' | 'replayHistory' | 'timeline'> {
  const throughFrameIndex = Math.min(frames.length - 1, Math.floor(cycle / 30));
  const frame = frames[throughFrameIndex];
  if (!frame) throw new RangeError(`No frame for cycle ${cycle}`);
  return {
    simulationState: frame.state,
    events: frame.events,
    interpolatedTick: cycle / 30,
    replayHistory: { frames, throughFrameIndex },
    timeline: { timelineKey: 'replay', paused, timeMs: cycle * 20 },
  };
}
