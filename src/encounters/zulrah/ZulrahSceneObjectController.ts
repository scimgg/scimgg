import { ZULRAH_CLOUD_LOC_ID } from '../../npcs/zulrah/constants';
import { FLOOR_EFFECT_DEPTH_BIAS } from '../../render/effects/spotAnimRenderPolicy';
import type { SceneObjectLocData } from '../../render/graphics/SceneObjectRenderer';
import type {
  SceneObjectController,
  SceneObjectFrameContext,
  SceneObjectSpec,
} from '../../render/graphics/sceneObjectTypes';
import { LocModelType } from '../../rs/config/loctype/LocModelType';
import type { SimulationState } from '../../types/simulation';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Zulrah's venom clouds: one 3x3 cloud LOC per landed cloud, from the snapshot. A cloud is drawn
 * from the tick it lands until it expires; one still in flight is the orb's to show.
 */
export class ZulrahSceneObjectController implements SceneObjectController<SimulationState, SceneObjectLocData> {
  consumeEvents(): void {}

  update(context: SceneObjectFrameContext<SimulationState>): readonly SceneObjectSpec<SceneObjectLocData>[] {
    const snapshot = context.state.encounter;
    if (snapshot.kind !== 'zulrah') return [];
    const tick = context.state.currentTick;
    return snapshot.visuals.clouds
      .filter((cloud) => tick >= cloud.landTick && tick < cloud.expireTick)
      .map((cloud) => cloudSpec(cloud.center, cloud.landTick));
  }
}

function cloudSpec(center: readonly [number, number], landTick: number): SceneObjectSpec<SceneObjectLocData> {
  // One id per cloud: two clouds on the same site at different times are different objects.
  const id = `zulrah-cloud-${center[0]}-${center[1]}-${landTick}`;
  return {
    id,
    meshId: id,
    materialId: 'osrs-npc',
    modelMatrix: IDENTITY,
    lifecycle: { kind: 'sync' },
    classification: 'groundDecal',
    style: { depthBias: FLOOR_EFFECT_DEPTH_BIAS },
    data: {
      kind: 'loc',
      locId: ZULRAH_CLOUD_LOC_ID,
      modelType: LocModelType.NORMAL,
      rotation: 0,
      seqId: -1,
      // The LOC is 3x3 and placed by its south-west tile.
      localX: center[0] - 1,
      localY: center[1] - 1,
      animationStartTick: landTick,
    },
  };
}
