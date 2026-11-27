import { isPracticeSpawn } from '../../../core/actors/NpcActor';
import type { GameEvent } from '../../../core/events/types';
import { VOID_FLARE_EXPLOSION_SPOT_ANIM_ID } from '../../../encounters/yamaP3/spotAnims';
import type { Coordinate, NpcSnapshot } from '../../../types/simulation';
import type { Projection2D } from '../../core/camera';
import { type ChargeBarDirection, chargeBarFillWidthPx, type RenderQueue } from '../../core/commands';
import type { ColorRGBA } from '../../core/types';
import { rgba, vec2 } from '../../core/types';
import { npcDespawnTimerRatio } from '../../overlay/npcDespawnTimer';
import { getLocCenterHeight } from '../../shared/renderUtils';
import type { SpotAnimRenderer } from '../SpotAnimRenderer';
import { getOneShotDurationCycles, updateOneShotSpotAnim } from '../spotAnimPlayback';

const Z_FLARE = 35;
const Z_FLARE_BAR = 36;
/**
 * Replay lookback for recent detonations: an upper bound on how long one stays on screen, not
 * its playback length. The explosion plays its own sequence at natural speed.
 */
export const VOID_FLARE_EXPLOSION_DURATION_TICKS = 3;
/**
 * Spotanim 3238's sequence (12137) runs 17 + 11 x 3 = 50 cycles. Used only until its frames load
 * (and for the 2D overlay, which never loads them).
 */
const EXPLOSION_FALLBACK_CYCLES = 50;
const CLIENT_TICKS_PER_GAME_TICK = 30;

const FLARE_COLOR: ColorRGBA = rgba(0.4, 0.0, 0.6, 0.55);
const FLARE_BORDER: ColorRGBA = rgba(0.6, 0.1, 0.8, 0.8);
const CHARGE_BAR_BG: ColorRGBA = rgba(0.2, 0.2, 0.2, 0.7);
const CHARGE_BAR_FILL: ColorRGBA = rgba(1.0, 0.85, 0.0, 0.9);
const CHARGE_BAR_FILL_CRITICAL: ColorRGBA = rgba(1.0, 0.2, 0.0, 0.9);

type VoidFlareVariant = 'fire' | 'shadow';

/** The per-frame inputs live flares are drawn from; only explosions come from events. */
export interface VoidFlareFrame {
  /**
   * The frame's NPC snapshots. The live voidflares among them are the flares drawn this frame,
   * with their fuse timing and spawn origin.
   */
  readonly npcs: readonly NpcSnapshot[];
  /** The Void Flares toggle. Off hides the fight's own flares; practice-spawned ones still show. */
  readonly showScheduled: boolean;
}

interface ExplodingFlare {
  flareId: string;
  position: Coordinate;
  variant: VoidFlareVariant;
  explodeTick: number;
}

function isCoordinate(value: unknown): value is Coordinate {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number';
}

function isVoidFlareVariant(value: unknown): value is VoidFlareVariant {
  return value === 'fire' || value === 'shadow';
}

export class VoidFlareController {
  private explodingFlares: ExplodingFlare[] = [];
  private terrainHeights: Int32Array[] | null = null;

  private readonly chargeBarDirection: ChargeBarDirection;

  constructor(options?: { chargeBarDirection?: ChargeBarDirection }) {
    this.chargeBarDirection = options?.chargeBarDirection ?? 'fill';
  }

  setTerrainHeights(heights: Int32Array[] | null): void {
    this.terrainHeights = heights;
  }

  /** Seek: rebuild the explosions still playing from recent events. Live flares need nothing. */
  reconstruct(events: readonly GameEvent[], renderer: SpotAnimRenderer): void {
    this.clearActive(renderer);
    this.consumeEvents(events);
  }

  /** Explosions only: a live flare is drawn from its snapshot, never from its spawn event. */
  consumeEvents(events: readonly GameEvent[]): void {
    for (const event of events) {
      if (
        event.type === 'voidflare_exploded' &&
        typeof event.flareId === 'string' &&
        isCoordinate(event.position) &&
        isVoidFlareVariant(event.variant)
      ) {
        this.explodingFlares.push({
          flareId: event.flareId,
          position: event.position,
          variant: event.variant,
          explodeTick: event.tick,
        });
      } else if (event.type === 'voidflare_destroyed' && typeof event.flareId === 'string') {
        this.explodingFlares = this.explodingFlares.filter((flare) => flare.flareId !== event.flareId);
      }
    }
  }

  update(
    renderer: SpotAnimRenderer,
    _currentTick: number,
    interpolatedTick: number,
    queue: RenderQueue,
    projection: Projection2D,
    renderMode: '2d' | '3d',
    flares: VoidFlareFrame,
  ): void {
    const { npcs } = flares;
    // The Void Flares toggle hides the fight's own flares only; a practice-spawned one always shows.
    const isShown = (flareId: string): boolean => {
      if (flares.showScheduled) return true;
      const npc = npcs.find((candidate) => candidate.id === flareId);
      return npc !== undefined && isPracticeSpawn(npc);
    };
    for (const npc of npcs) {
      if (npc.archetypeId !== 'voidflare' || !npc.alive || !isShown(npc.id)) continue;
      // Same timing as the overlay fuse bar, including staying hidden until the flare activates.
      this.buildFlare2D(queue, projection, npc.position, npcDespawnTimerRatio(npc, interpolatedTick));
    }

    const cycle = interpolatedTick * CLIENT_TICKS_PER_GAME_TICK;
    const durationCycles = getOneShotDurationCycles(
      renderer,
      VOID_FLARE_EXPLOSION_SPOT_ANIM_ID,
      EXPLOSION_FALLBACK_CYCLES,
    );
    this.explodingFlares = this.explodingFlares.filter((flare) => {
      const instanceId = `voidflare-explode-${flare.flareId}`;
      const startCycle = flare.explodeTick * CLIENT_TICKS_PER_GAME_TICK;

      if (cycle >= startCycle + durationCycles) {
        renderer.despawn(instanceId);
        return false;
      }
      if (!isShown(flare.flareId)) {
        // Kept, not dropped, so switching the toggle back on mid-explosion resumes it in phase.
        renderer.despawn(instanceId);
        return true;
      }

      if (renderMode === '3d') {
        updateOneShotSpotAnim(
          renderer,
          {
            instanceId,
            spotAnimId: VOID_FLARE_EXPLOSION_SPOT_ANIM_ID,
            startCycle,
            transformSource: {
              kind: 'static',
              value: {
                position: [
                  flare.position[0] + 1,
                  flare.position[1] + 1,
                  getLocCenterHeight(this.terrainHeights, flare.position[0], flare.position[1], 2, 2),
                ],
              },
            },
            style: { zIndex: Z_FLARE },
            heightOffsetMode: 'sequence',
            fallbackDurationCycles: EXPLOSION_FALLBACK_CYCLES,
          },
          cycle,
        );
      } else {
        renderer.despawn(instanceId);
        this.buildExplosion2D(queue, projection, flare.position, Math.max(0, cycle - startCycle) / durationCycles);
      }

      return true;
    });
  }

  clearActive(renderer: SpotAnimRenderer): void {
    for (const flare of this.explodingFlares) {
      renderer.despawn(`voidflare-explode-${flare.flareId}`);
    }
    this.explodingFlares = [];
  }

  private buildFlare2D(
    queue: RenderQueue,
    projection: Projection2D,
    position: Coordinate,
    chargeProgress: number | null,
  ): void {
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        const tile = { x: position[0] + dx, y: position[1] + dy };
        const points = projection.tilePolygonScreen(tile);
        if (points.length < 4) continue;
        queue.commands.push({
          kind: 'poly2d',
          points,
          fill: FLARE_COLOR,
          stroke: { color: FLARE_BORDER, widthPx: 1.5 },
          zIndex: Z_FLARE,
        });
      }
    }

    if (chargeProgress === null) return;
    const sw = projection.tileToScreen({ x: position[0], y: position[1] });
    const ne = projection.tileToScreen({ x: position[0] + 2, y: position[1] + 2 });
    if (!sw || !ne) return;
    const centerX = (sw.x + ne.x) / 2;
    const barY = Math.min(sw.y, ne.y) - 6;
    const barWidth = Math.abs(ne.x - sw.x) * 0.8;
    const barHeight = 4;
    const barLeft = centerX - barWidth / 2;

    queue.commands.push({
      kind: 'poly2d',
      points: [
        vec2(barLeft, barY),
        vec2(barLeft + barWidth, barY),
        vec2(barLeft + barWidth, barY + barHeight),
        vec2(barLeft, barY + barHeight),
      ],
      fill: CHARGE_BAR_BG,
      zIndex: Z_FLARE_BAR,
    });

    const fillWidth = chargeBarFillWidthPx(chargeProgress, barWidth, this.chargeBarDirection);
    const fillColor = chargeProgress >= 0.8 ? CHARGE_BAR_FILL_CRITICAL : CHARGE_BAR_FILL;
    if (fillWidth > 0) {
      queue.commands.push({
        kind: 'poly2d',
        points: [
          vec2(barLeft, barY),
          vec2(barLeft + fillWidth, barY),
          vec2(barLeft + fillWidth, barY + barHeight),
          vec2(barLeft, barY + barHeight),
        ],
        fill: fillColor,
        zIndex: Z_FLARE_BAR,
      });
    }
  }

  private buildExplosion2D(queue: RenderQueue, projection: Projection2D, position: Coordinate, progress: number): void {
    const alpha = 0.6 * (1 - progress);
    const explosionColor = rgba(0.8, 0.2, 1.0, alpha);

    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        const tile = { x: position[0] + dx, y: position[1] + dy };
        const points = projection.tilePolygonScreen(tile);
        if (points.length < 4) continue;
        queue.commands.push({
          kind: 'poly2d',
          points,
          fill: explosionColor,
          zIndex: Z_FLARE + 1,
        });
      }
    }
  }
}
