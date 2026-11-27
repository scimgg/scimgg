import { GRID_SIZE, getArenaBounds, isWalkableTile } from '../../../core/constants';
import type { GameEvent } from '../../../core/events/types';
import { isSouthOfArenaEntrance } from '../../../encounters/yamaP3/constants';
import { getWaveTiles, type WaveConfig } from '../../../encounters/yamaP3/waves';
import { SpotAnimID } from '../../../rs/config/spotanimtype/SpotAnimID';
import { packHsl } from '../../../rs/util/ColorUtil';
import type { NpcMesh3DCommand, RenderQueue } from '../../core/commands';
import { getLocCenterHeight, getTerrainHeight } from '../../shared/renderUtils';
import type { SpotAnimRenderer } from '../SpotAnimRenderer';

const Z_WAVE = 20;
const WAVE_GROUP = 'waves';
const WAVE_TILE_HSL = packHsl(83, 200, 100);
const WAVE_TILE_ALPHA = 0.35;
const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class WaveController {
  private terrainHeights: Int32Array[] | null = null;
  private activeWaveIds = new Set<string>();

  setTerrainHeights(heights: Int32Array[] | null): void {
    this.terrainHeights = heights;
  }

  consumeEvents(_events: GameEvent[]): void {
    // No-op: wave rendering is driven purely by getWaveTiles().
  }

  update(
    renderer: SpotAnimRenderer,
    currentTick: number,
    interpolatedTick: number,
    queue: RenderQueue,
    showTiles: boolean,
    waveConfig?: WaveConfig,
  ): void {
    // No tick gating: getWaveTiles() returns an empty array when there
    // are no active waves, which naturally produces an empty nextIds set
    // and despawns everything via the diff loop below.
    const bounds = getArenaBounds();
    const minX = bounds?.minX ?? 0;
    const maxX = bounds?.maxX ?? GRID_SIZE;
    const minY = bounds?.minY ?? 0;
    const maxY = bounds?.maxY ?? GRID_SIZE;

    const intTick = Math.floor(interpolatedTick);
    const tickProgress = interpolatedTick - intTick;
    const waveTiles = getWaveTiles(intTick, minX, maxX, minY, maxY, waveConfig);
    const nextIds = new Set<string>();

    if (showTiles) {
      // The engine checks wave damage for tick T+1 against the tile the player ends tick T on
      // (`resolveHazards` runs before movement). Highlighting T+1's tiles while state T is shown
      // marks where a true tile takes the next wave hit (unless a perfect dodge grants immunity).
      // Keyed off the state tick, not the interpolated one, which can reach T+1 before state does.
      const hitTiles = getWaveTiles(currentTick + 1, minX, maxX, minY, maxY, waveConfig);
      for (const hitTile of hitTiles) {
        if (!isWalkableTile(hitTile.x, hitTile.y) || isSouthOfArenaEntrance(hitTile.y)) continue;
        this.pushTileHighlight(queue, hitTile.x, hitTile.y, hitTile.waveType);
      }
    }

    for (let i = 0; i < waveTiles.length; i++) {
      const waveTile = waveTiles[i];
      if (!isWalkableTile(waveTile.x, waveTile.y)) continue;
      if (isSouthOfArenaEntrance(waveTile.y)) continue;

      let layerProgress: number;
      if (waveTile.layer === 0) {
        if (tickProgress >= 0.5) continue;
        layerProgress = tickProgress * 2;
      } else {
        if (tickProgress < 0.5) continue;
        layerProgress = (tickProgress - 0.5) * 2;
      }

      const instanceId = `wave-${intTick}-${i}`;
      nextIds.add(instanceId);
      renderer.upsert({
        instanceId,
        groupId: WAVE_GROUP,
        spotAnimId: SpotAnimID.VFX_SHADOW_WALL_01,
        transform: {
          kind: 'static',
          value: {
            position: [
              waveTile.x + 0.5,
              waveTile.y + 0.5,
              getLocCenterHeight(this.terrainHeights, waveTile.x, waveTile.y, 1, 1),
            ],
            yaw2048: waveTile.waveType === 'L' ? 1792 : 256,
          },
        },
        lifecycle: { kind: 'manual' },
        style: { zIndex: Z_WAVE },
        frameProgress: layerProgress,
      });
    }

    for (const activeId of this.activeWaveIds) {
      if (!nextIds.has(activeId)) {
        renderer.despawn(activeId);
      }
    }
    this.activeWaveIds = nextIds;
  }

  clearActive(renderer: SpotAnimRenderer): void {
    if (this.activeWaveIds.size === 0) return;
    renderer.despawnGroup(WAVE_GROUP);
    this.activeWaveIds.clear();
  }

  private pushTileHighlight(queue: RenderQueue, x: number, y: number, waveType: string): void {
    const h00 = -getTerrainHeight(this.terrainHeights, x, y) / 128 + 0.01;
    const h10 = -getTerrainHeight(this.terrainHeights, x + 1, y) / 128 + 0.01;
    const h01 = -getTerrainHeight(this.terrainHeights, x, y + 1) / 128 + 0.01;
    const h11 = -getTerrainHeight(this.terrainHeights, x + 1, y + 1) / 128 + 0.01;

    queue.commands.push({
      kind: 'mesh3d',
      meshId: `wave-tile-${x}-${y}-${waveType}`,
      materialId: 'tile-outline',
      modelMatrix: IDENTITY_MATRIX,
      // Flat ground telegraph tile — double-sided (backface culling is the global default).
      cullFace: 'none',
      positions: new Float32Array([
        x,
        y,
        h00,
        x + 1,
        y,
        h10,
        x + 1,
        y + 1,
        h11,
        x,
        y,
        h00,
        x + 1,
        y + 1,
        h11,
        x,
        y + 1,
        h01,
      ]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      perVertexHslColors: new Float32Array([
        WAVE_TILE_HSL,
        WAVE_TILE_HSL,
        WAVE_TILE_HSL,
        WAVE_TILE_HSL,
        WAVE_TILE_HSL,
        WAVE_TILE_HSL,
      ]),
      perVertexAlphas: new Float32Array([
        WAVE_TILE_ALPHA,
        WAVE_TILE_ALPHA,
        WAVE_TILE_ALPHA,
        WAVE_TILE_ALPHA,
        WAVE_TILE_ALPHA,
        WAVE_TILE_ALPHA,
      ]),
      depth: 'none',
      blend: 'normal',
      zIndex: Z_WAVE,
    } as NpcMesh3DCommand);
  }
}
