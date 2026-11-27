import { zukWaveState } from '../../core/encounters/snapshot';
import { type GameEvent, isCoreEvent } from '../../core/events/types';
import { type ZukIntroCameraPoint, zukIntroAddTick, zukIntroCutsceneFrame } from '../../encounters/zuk/introCutscene';
import { zukTargetsPlayer } from '../../encounters/zuk/targeting';
import { ZUK_NPC_ID } from '../../npcs/inferno/constants';
import { rgbToHsl } from '../../rs/util/ColorUtil';
import type { Coordinate, NpcSnapshot, SimulationState } from '../../types/simulation';
import { DEFAULT_TILE_MARKER_WIDTH } from '../../types/tileMarkers';
import type { Projection2D } from '../core/camera';
import type { RenderQueue } from '../core/commands';
import { rgbaFromHex } from '../core/types';
import { getTerrainHeightInterpolated } from '../shared/renderUtils';
import { SceneCompositor, Z_LAYERS } from './SceneCompositor';
import type { SceneCutsceneFrame } from './types';

const ZUK_SAFE_COLOR = '#79C99E';
const ZUK_SAFE_FILL = rgbaFromHex(ZUK_SAFE_COLOR, 0.04);
const ZUK_SAFE_BORDER = { color: rgbaFromHex(ZUK_SAFE_COLOR, 0.65), widthPx: DEFAULT_TILE_MARKER_WIDTH };
const ZUK_SAFE_HSL = rgbToHsl(Number.parseInt(ZUK_SAFE_COLOR.slice(1), 16));

/**
 * The Inferno's scene: its NPCs play the shared cue player's clips (`npcPresentation: 'cues'`), plus
 * wave 69's own presentation: the intro's fade and camera, the shield-safe overlay and Zuk's early
 * presentation origin.
 */
export class InfernoSceneCompositor extends SceneCompositor {
  constructor() {
    super({ npcPresentation: 'cues' });
  }

  /** Wave 69's intro after wave 68: its fade and scripted camera (`zukIntroCutsceneFrame`). */
  getCutsceneFrame(state: SimulationState, interpolatedTick: number): SceneCutsceneFrame | null {
    const snapshot = state.encounter;
    if (snapshot.kind !== 'inferno') return null;
    const frame = zukIntroCutsceneFrame(snapshot.visuals.zukControlTick, interpolatedTick);
    if (!frame) return null;
    if (!frame.camera) return { fadeOpacity: frame.fadeOpacity, camera: null };
    const { eye, lookAt, shake } = frame.camera;
    // OSRS heights are negative up: a point `height` above the ground is world z (height - ground) / 128.
    const point = ({ tile, height }: ZukIntroCameraPoint, offset: readonly [number, number, number]) => {
      const x = tile[0] + 0.5 + offset[0] / 128;
      const y = tile[1] + 0.5 + offset[2] / 128;
      return { x, y, z: (height + offset[1] - getTerrainHeightInterpolated(this.terrainHeights, x, y)) / 128 };
    };
    return { fadeOpacity: frame.fadeOpacity, camera: { eye: point(eye, shake), lookAt: point(lookAt, [0, 0, 0]) } };
  }

  protected override renderEncounterDebugOverlays(
    queue: RenderQueue,
    projection: Projection2D,
    simulationState: SimulationState,
    _interpolatedTick: number,
    is2D: boolean,
    _debugFlags: Record<string, boolean | number>,
  ): void {
    const zuk = zukWaveState(simulationState.encounter);
    if (simulationState.mechanicsConfig.zukShieldSafeTiles !== true || zuk === null) return;
    if (!simulationState.npcs.some((npc) => npc.archetypeId === 'zuk' && npc.alive)) return;
    if (!is2D && !this.terrainHeights) return;
    const bounds = this.getGridBounds();
    const walkable = this.getArenaWalkabilityChecker();
    if (!bounds || !walkable) return;
    if (!simulationState.npcs.some((npc) => npc.archetypeId === 'zuk_shield' && npc.alive)) return;
    const shieldNextX = zuk.shieldNextX;
    if (shieldNextX === null) return;
    const isSafe = (x: number, y: number) =>
      x >= bounds.minX &&
      x <= bounds.maxX &&
      y >= bounds.minY &&
      y <= bounds.maxY &&
      walkable(x, y) &&
      !zukTargetsPlayer(shieldNextX, [x, y]);
    const edges: [Coordinate, Coordinate][] = [];
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      for (let y = bounds.minY; y <= bounds.maxY; y++) {
        if (!isSafe(x, y)) continue;
        if (is2D) {
          const points = [
            [x, y],
            [x + 1, y],
            [x + 1, y + 1],
            [x, y + 1],
          ].map(([px, py]) => projection.tileToScreen({ x: px, y: py, level: 0 }));
          if (points.every((point) => point !== null)) {
            queue.commands.push({ kind: 'poly2d', points, fill: ZUK_SAFE_FILL, zIndex: Z_LAYERS.GRID + 1 });
          }
        } else {
          this.pushTileMesh3D(queue, x, y, ZUK_SAFE_HSL, ZUK_SAFE_FILL.a, 'zuk-safe-fill', 0.008, Z_LAYERS.GRID + 1);
        }
        if (!isSafe(x, y - 1))
          edges.push([
            [x, y],
            [x + 1, y],
          ]);
        if (!isSafe(x + 1, y))
          edges.push([
            [x + 1, y],
            [x + 1, y + 1],
          ]);
        if (!isSafe(x, y + 1))
          edges.push([
            [x, y + 1],
            [x + 1, y + 1],
          ]);
        if (!isSafe(x - 1, y))
          edges.push([
            [x, y],
            [x, y + 1],
          ]);
      }
    }
    queue.commands.push(
      ...this.createJoinedEdgeCommands(edges, is2D ? projection : null, {
        ...ZUK_SAFE_BORDER,
        hslColor: ZUK_SAFE_HSL,
        zIndex: Z_LAYERS.GRID + 2,
      }),
    );
  }

  /** A pruned actor's drawn presentation goes with it, corpse included. */
  protected override onEncounterEvents(events: GameEvent[]): void {
    for (const event of events)
      if (isCoreEvent(event, 'actor_despawned'))
        this.npcInstanceManager.removePresentation(this.actorRenderIdOf(event.actorId));
  }

  /**
   * Zuk after wave 68 is presented from the intro's add: his spawn tick is control C (the cast
   * clock's epoch), but the intro adds him, rising, at C-8 (`zukIntroAddTick`), so his intro clip is
   * within his presented life.
   */
  protected override presentedFromTick(npc: NpcSnapshot, state: SimulationState): number {
    const spawnTick = npc.spawnTick ?? 0;
    const snapshot = state.encounter;
    if (npc.npcTypeId !== ZUK_NPC_ID || snapshot.kind !== 'inferno') return spawnTick;
    const controlTick = snapshot.visuals.zukControlTick;
    return controlTick !== null && spawnTick === controlTick ? zukIntroAddTick(controlTick) : spawnTick;
  }
}
