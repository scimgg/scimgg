import { MOLTEN_SAND_LOC_ID } from '../../npcs/colosseum/constants';
import { FLOOR_EFFECT_DEPTH_BIAS } from '../../render/effects/spotAnimRenderPolicy';
import type { SceneObjectLocData } from '../../render/graphics/SceneObjectRenderer';
import type {
  SceneObjectController,
  SceneObjectFrameContext,
  SceneObjectSpec,
} from '../../render/graphics/sceneObjectTypes';
import { LocModelType } from '../../rs/config/loctype/LocModelType';
import type { SimulationState } from '../../types/simulation';
import { SOL_BOUNDARY_WARRIORS } from './arenaBoundary';

/**
 * `vfx_colosseum_hot_sand_01_despawn_01`: 15 frames x 4 cycles = 60 cycles, so started on Sol's death
 * tick it ends as the pools are replaced at death+2 (loc_anim at K:4221, M:8512, N:7781, L:5833).
 * The capture re-sends it at D+1; whether the client restarts it there is not modeled.
 */
export const MOLTEN_SAND_DESPAWN_SEQ_ID = 10814;

const IDENTITY = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Draws each molten-sand pool as the game's own `colosseum_holy_fire` LOC.
 *
 * Both captures place a real LOC on every burned tile (a loc placement record for `colosseum_holy_fire`)
 * and leave it there until Sol dies: every pool plays its despawn from the death tick and all of
 * them are replaced by an invisible LOC at death+2 (K:4223, 29 pools). That makes the pools persistent scene objects driven by encounter state
 * rather than one-shot effects, which is exactly what this path is for.
 *
 * The capture varies pool rotation between 0 and 3. Deriving it from the tile keeps a given pool
 * looking the same every frame while still breaking up the tiling, without spending encounter RNG
 * on something purely cosmetic.
 */
export class SolHereditSceneObjectController implements SceneObjectController<SimulationState, SceneObjectLocData> {
  private readonly boundary = SOL_BOUNDARY_WARRIORS.map((placement) => {
    const id = `sol-boundary-${placement.localX}-${placement.localY}`;
    return {
      id,
      meshId: id,
      materialId: 'osrs-npc',
      modelMatrix: IDENTITY(),
      lifecycle: { kind: 'sync' },
      classification: 'sceneMesh',
      data: {
        kind: 'loc',
        locId: placement.locId,
        modelType: LocModelType.NORMAL,
        rotation: placement.rotation,
        seqId: -1,
        localX: placement.localX,
        localY: placement.localY,
        level: placement.level,
      },
    } satisfies SceneObjectSpec<SceneObjectLocData>;
  });

  consumeEvents(): void {}

  update(context: SceneObjectFrameContext<SimulationState>): readonly SceneObjectSpec<SceneObjectLocData>[] {
    const snapshot = context.state.encounter;
    if (snapshot.kind !== 'sol_heredit') return [];
    // The shield warriors close the open waves arena on the tick Sol is added (A:4976, K:3998). The
    // snapshot leaves C out in recordings older than the waves, which all start on Sol (C = 0).
    const control = snapshot.visuals.solControlTick === undefined ? 0 : snapshot.visuals.solControlTick;
    const fenced = control !== null && context.currentTick >= control;
    const despawning = snapshot.state.sandDespawning;
    const seqId = despawning ? MOLTEN_SAND_DESPAWN_SEQ_ID : -1;
    // The despawn starts on Sol's death tick, which the recorded outcome keeps, so a replay seek to
    // death+1 lands mid-sequence instead of restarting it. Without a recorded outcome (completion
    // owned outside the encounter) the renderer anchors to the tick it first sees the despawn.
    const outcome = context.state.encounterOutcome;
    const animationStartTick = despawning && outcome.phase !== 'active' ? outcome.decisiveTick : undefined;
    const pools = snapshot.state.sandTiles.map(([x, y]) => {
      const id = `sol-sand-${x}-${y}`;
      return {
        id,
        meshId: id,
        materialId: 'osrs-npc',
        modelMatrix: IDENTITY(),
        lifecycle: { kind: 'sync' },
        classification: 'groundDecal',
        // The pool is coplanar with the arena floor; the default decal bias still lets it flicker.
        style: { depthBias: FLOOR_EFFECT_DEPTH_BIAS },
        data: {
          kind: 'loc',
          locId: MOLTEN_SAND_LOC_ID,
          modelType: LocModelType.NORMAL,
          rotation: Math.abs(x * 3 + y * 7) % 4,
          seqId,
          localX: x,
          localY: y,
          ...(animationStartTick !== undefined ? { animationStartTick } : {}),
        },
      } satisfies SceneObjectSpec<SceneObjectLocData>;
    });
    return fenced ? [...this.boundary, ...pools] : pools;
  }
}
