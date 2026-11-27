import { GRID_SIZE } from '../../../core/constants';
import { isYamaSnapshot } from '../../../core/encounters/snapshot';
import type { FireballAngle } from '../../../encounters/yamaP3/constants';
import {
  getExplosionTiles,
  getFireballImpactTiles,
  getThreeFireballPositions,
} from '../../../encounters/yamaP3/fireball';
import { SpotAnimID } from '../../../rs/config/spotanimtype/SpotAnimID';
import type { Coordinate, SimulationState } from '../../../types/simulation';
import type { Projection2D } from '../../core/camera';
import type { RenderQueue } from '../../core/commands';
import type { ColorRGBA } from '../../core/types';
import { rgba, vec2 } from '../../core/types';
import { getLocCenterHeight } from '../../shared/renderUtils';
import type { SpotAnimRenderer } from '../SpotAnimRenderer';

const Z_FIREBALL = 70;
const Z_FIREBALL_SHADOW = 55;
const Z_EXPLOSION = 30;
/**
 * The fireball's falling shadow and impact are flat decals that sit at exactly the
 * terrain height. Under the renderer's reversed-Z `GL_GREATER` depth test they tie the
 * ground depth and get culled. A tiny per-decal forward depth bias nudges them ahead of
 * the ground in depth-space only — the decal stays visually flat on the floor — mirroring
 * RuneLite's per-face `faceBias` for ground graphics. The value matches the other
 * coplanar-effect depth biases.
 */
const GROUND_DECAL_DEPTH_BIAS = 0.0005;
const COLORS_IMPACT: ColorRGBA = rgba(1, 0.4, 0, 0.5);
const COLORS_EXPLOSION: ColorRGBA = rgba(1, 0.2, 0, 0.4);

function isFireballAngle(angle: string | null): angle is FireballAngle {
  return angle === 'vertical' || angle === 'horizontal' || angle === 'diagonal' || angle === 'diagonal-alt';
}

export class FireballController {
  private terrainHeights: Int32Array[] | null = null;
  private active3dIds = new Set<string>();

  setTerrainHeights(heights: Int32Array[] | null): void {
    this.terrainHeights = heights;
  }

  update(
    renderer: SpotAnimRenderer,
    _currentTick: number,
    interpolatedTick: number,
    queue: RenderQueue,
    projection: Projection2D,
    state: SimulationState,
    renderMode: '2d' | '3d',
  ): void {
    const { currentTick } = state;
    const fireballStates = isYamaSnapshot(state.encounter) ? state.encounter.visuals.fireballStates : [];
    const next3dIds = new Set<string>();

    for (const fb of fireballStates) {
      const centerPosition = fb.centerPosition ?? null;
      if (!fb.active || !centerPosition || !isFireballAngle(fb.angle)) continue;

      const startTick = currentTick - fb.ticksIntoPhase;
      // 3D instance ids are keyed by the fireball's unique phaseIndex, not its startTick:
      // manual (debug) and scheduled sets can share a startTick and would otherwise upsert
      // the same instances and overwrite each other.
      const idKey = fb.phaseIndex ?? startTick;
      let renderTick = currentTick;

      if (fb.ticksIntoPhase < 4) {
        renderTick = interpolatedTick;
        if (renderTick - startTick >= 4) {
          renderTick = startTick + 3.99;
        }
      }

      const positions = getThreeFireballPositions(centerPosition, fb.angle);
      const allPositions = [positions.center, positions.side1, positions.side2];
      const shadowTick = fb.ticksIntoPhase < 5 ? Math.min(interpolatedTick, startTick + 4.99) : currentTick;
      const ticksIntoPhase = shadowTick - startTick;
      const fallingProgress = Math.max(0, Math.min(1, (renderTick - startTick) / 4));

      if (renderMode === '2d') {
        if (fb.ticksIntoPhase < 3) {
          const progress = Math.min((renderTick - startTick) / 3, 1.0);
          this.buildFallingFireballs2D(queue, projection, allPositions, progress);
        } else if (fb.ticksIntoPhase === 3) {
          this.buildExplosionTiles(queue, projection, getFireballImpactTiles(centerPosition, fb.angle), COLORS_IMPACT);
        } else if (fb.ticksIntoPhase === 4) {
          this.buildExplosionTiles(queue, projection, getExplosionTiles(centerPosition, fb.angle), COLORS_EXPLOSION);
        }
      } else {
        if (fb.ticksIntoPhase >= 3) {
          const elapsedSec = (ticksIntoPhase - 3) * 0.6;
          const allExplosionTiles = getExplosionTiles(centerPosition, fb.angle);
          this.buildExplosionSpotAnims(renderer, next3dIds, allExplosionTiles, elapsedSec, centerPosition, idKey);
        }

        if (fb.ticksIntoPhase < 4) {
          this.buildFallingFireballs3D(renderer, next3dIds, allPositions, fallingProgress, idKey);
        }
      }
    }

    if (renderMode === '3d') {
      for (const id of this.active3dIds) {
        if (!next3dIds.has(id)) {
          renderer.despawn(id);
        }
      }
      this.active3dIds = next3dIds;
    } else {
      for (const id of this.active3dIds) {
        renderer.despawn(id);
      }
      this.active3dIds.clear();
    }
  }

  clearActive(renderer: SpotAnimRenderer): void {
    for (const id of this.active3dIds) {
      renderer.despawn(id);
    }
    this.active3dIds.clear();
  }

  private buildFallingFireballs2D(
    queue: RenderQueue,
    projection: Projection2D,
    positions: Coordinate[],
    progress: number,
  ): void {
    const approach = projection.tileDeltaToScreen({ x: 0, y: -2 });
    if (!approach) return;
    const t = 1 - progress;

    for (const pos of positions) {
      const targetCenter = projection.tileToScreen({ x: pos[0], y: pos[1] });
      if (!targetCenter) continue;
      const center = {
        x: targetCenter.x + approach.x * t,
        y: targetCenter.y + approach.y * t - 22 * t,
      };

      const shadowRadius = 16 * (1 - t * 0.5);
      queue.commands.push({
        kind: 'ellipse2d',
        center: targetCenter,
        radiusX: shadowRadius,
        radiusY: shadowRadius * 0.6,
        fill: rgba(0.05, 0.0, 0.0, 0.6 + progress * 0.3),
        stroke: { color: rgba(1, 0.3, 0, 0.3 + progress * 0.3), widthPx: 1 },
        zIndex: Z_FIREBALL_SHADOW,
      });

      const glowRadius = 24;
      queue.commands.push({
        kind: 'circle2d',
        center,
        radiusPx: glowRadius,
        fill: {
          center: vec2(center.x, center.y),
          radius: glowRadius,
          stops: [
            { offset: 0, color: rgba(1, 0.5, 0, 0.6) },
            { offset: 1, color: rgba(1, 0.2, 0, 0) },
          ],
        },
        zIndex: Z_FIREBALL_SHADOW,
      });

      const coreRadius = 14;
      queue.commands.push({
        kind: 'circle2d',
        center,
        radiusPx: coreRadius,
        fill: {
          center: vec2(center.x, center.y - 2),
          radius: coreRadius,
          stops: [
            { offset: 0, color: rgba(1, 1, 0.8, 1) },
            { offset: 0.4, color: rgba(1, 0.8, 0, 1) },
            { offset: 0.7, color: rgba(1, 0.4, 0, 1) },
            { offset: 1, color: rgba(0.8, 0.1, 0, 0.8) },
          ],
        },
        stroke: { color: rgba(0.6, 0.1, 0, 0.8), widthPx: 1 },
        zIndex: Z_FIREBALL,
      });
    }
  }

  private buildExplosionTiles(
    queue: RenderQueue,
    projection: Projection2D,
    tiles: Coordinate[],
    color: ColorRGBA,
  ): void {
    for (const tile of tiles) {
      if (tile[0] >= 0 && tile[0] < GRID_SIZE && tile[1] >= 0 && tile[1] < GRID_SIZE) {
        const points = projection.tilePolygonScreen({ x: tile[0], y: tile[1] });
        if (points.length < 4) continue;
        queue.commands.push({ kind: 'poly2d', points, fill: color, zIndex: Z_EXPLOSION });
      }
    }
  }

  private buildFallingFireballs3D(
    renderer: SpotAnimRenderer,
    next3dIds: Set<string>,
    positions: Coordinate[],
    progress: number,
    idKey: number,
  ): void {
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      const instanceId = `fireball-falling-${idKey}-${i}`;
      next3dIds.add(instanceId);

      renderer.upsert({
        instanceId,
        spotAnimId: SpotAnimID.VFX_PLAYER_YAMA_FALLING_ROCK_IMPACT01,
        transform: {
          kind: 'static',
          value: {
            position: [pos[0] + 0.5, pos[1] + 0.5, getLocCenterHeight(this.terrainHeights, pos[0], pos[1], 1, 1)],
          },
        },
        lifecycle: { kind: 'manual' },
        frameProgress: progress,
        style: { zIndex: Z_FIREBALL, depthBias: GROUND_DECAL_DEPTH_BIAS },
      });
    }
  }

  private buildExplosionSpotAnims(
    renderer: SpotAnimRenderer,
    next3dIds: Set<string>,
    tiles: Coordinate[],
    elapsedSec: number,
    center: Coordinate,
    idKey: number,
  ): void {
    const frameLengths = renderer.getFrameLengths(SpotAnimID.VFX_FLAMING_SKULL_SHADOW_IMPACT01) ?? [];
    let totalDuration = 0;
    for (const len of frameLengths) totalDuration += len;

    const ROW_DELAY_SEC = 7 / 60;
    const ANIM_DURATION_SEC = totalDuration > 0 ? totalDuration * 0.02 : 37 / 60;
    const [cx, cy] = center;

    let maxDist = 0;
    for (const tile of tiles) {
      const dist = Math.max(Math.abs(tile[0] - cx), Math.abs(tile[1] - cy));
      if (dist > maxDist) maxDist = dist;
    }

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      if (tile[0] < 0 || tile[0] >= GRID_SIZE || tile[1] < 0 || tile[1] >= GRID_SIZE) continue;

      const dist = Math.max(Math.abs(tile[0] - cx), Math.abs(tile[1] - cy));
      const row = maxDist - dist;
      const tileStartSec = row * ROW_DELAY_SEC;
      const tileElapsed = elapsedSec - tileStartSec;

      if (tileElapsed < 0 || tileElapsed >= ANIM_DURATION_SEC) {
        continue;
      }

      const tileProgress = tileElapsed / ANIM_DURATION_SEC;
      const instanceId = `fireball-explosion-${idKey}-${i}`;
      next3dIds.add(instanceId);

      renderer.upsert({
        instanceId,
        spotAnimId: SpotAnimID.VFX_FLAMING_SKULL_SHADOW_IMPACT01,
        transform: {
          kind: 'static',
          value: {
            position: [tile[0] + 0.5, tile[1] + 0.5, getLocCenterHeight(this.terrainHeights, tile[0], tile[1], 1, 1)],
          },
        },
        lifecycle: { kind: 'manual' },
        frameProgress: tileProgress,
        style: { zIndex: Z_EXPLOSION, depthBias: GROUND_DECAL_DEPTH_BIAS },
      });
    }
  }
}
