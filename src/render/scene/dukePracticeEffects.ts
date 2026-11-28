import { DUKE_CENTER_TILE, SLAM_TILES } from '../../encounters/dukePractice/arena';
import {
  DUKE_BILE_PROJECTILE,
  DUKE_MAGIC_PROJECTILE,
  DUKE_SPOT_ANIMS,
  DUKE_VENT_ARM_TICKS,
  DUKE_VENT_PROJECTILE,
  DUKE_VENT_SMOKE_CYCLE_TICKS,
} from '../../encounters/dukePractice/constants';
import type { DukePracticeVisuals } from '../../encounters/dukePractice/snapshot';
import type { Coordinate } from '../../types/simulation';
import { CLIENT_TICK_MS, GAME_TICK_MS } from '../core/animation';
import type { SurfaceHeightResolver } from '../effects/controllers/ProjectileController';
import { ProjectileFlight } from '../effects/ProjectileFlight';
import { advanceProjectileMotion, createProjectileMotion, projectileDirection } from '../effects/projectileMotion';
import type { SpotAnimRenderer } from '../effects/SpotAnimRenderer';
import { updateOneShotSpotAnim } from '../effects/spotAnimPlayback';
import type { TransformSource } from '../effects/spotAnimTypes';
import { getTerrainHeightInterpolated } from '../shared/renderUtils';

const CYCLES_PER_TICK = GAME_TICK_MS / CLIENT_TICK_MS;
const DUKE_MOUTH_X = DUKE_CENTER_TILE[0] + 0.5;
const DUKE_MOUTH_Y = DUKE_CENTER_TILE[1] - 1.5;
// 20261126-232238-Duke.jsonl:4697–4704, west to east along the front row.
const GROUND_ICICLES = [
  DUKE_SPOT_ANIMS.groundIciclesOuter,
  DUKE_SPOT_ANIMS.groundIciclesMidOuter,
  DUKE_SPOT_ANIMS.groundIciclesMidInner,
  DUKE_SPOT_ANIMS.groundIciclesCenter,
  DUKE_SPOT_ANIMS.groundIciclesMidInner,
  DUKE_SPOT_ANIMS.groundIciclesMidOuter,
  DUKE_SPOT_ANIMS.groundIciclesOuter,
];

type DukeProjectile = {
  startCycle: number;
  endCycle: number;
  startHeight: number;
  endHeight: number;
  startOffset: number;
  slope: number;
};

function atGroundPosition([x, y]: Coordinate): TransformSource {
  return {
    kind: 'dynamic',
    resolve: (_tick, _time, heights) => ({
      position: [x + 0.5, y + 0.5, -getTerrainHeightInterpolated(heights, x + 0.5, y + 0.5) / 128],
    }),
  };
}

function fromDuke([x, y]: Coordinate, impactTick: number, flightTicks: number): TransformSource {
  const fromX = DUKE_MOUTH_X;
  const fromY = DUKE_MOUTH_Y;
  const dx = x + 0.5 - fromX;
  const dy = y + 0.5 - fromY;
  return {
    kind: 'dynamic',
    resolve: (_tick, time, heights) => {
      const fraction = Math.max(0, Math.min(1, 1 - (impactTick - time) / flightTicks));
      const worldX = fromX + dx * fraction;
      const worldY = fromY + dy * fraction;
      const height = -getTerrainHeightInterpolated(heights, worldX, worldY) / 128;
      return {
        position: [worldX, worldY, height + 1.8 - 1.55 * fraction + 0.4 * Math.sin(Math.PI * fraction)],
        yaw2048: (Math.round(Math.atan2(-dx, -dy) * (1024 / Math.PI)) + 2048) % 2048,
      };
    },
  };
}

function projectileTo([x, y]: Coordinate, launchCycle: number, projectile: DukeProjectile): TransformSource {
  const { startCycle, endCycle, startHeight, endHeight, startOffset, slope } = projectile;
  const flightCycles = endCycle - startCycle;
  const worldX = x + 0.5;
  const worldY = y + 0.5;
  return {
    kind: 'dynamic',
    resolve: (_tick, time, heights) => {
      const motion = createProjectileMotion(
        {
          source: {
            worldX: DUKE_MOUTH_X,
            worldY: DUKE_MOUTH_Y,
            resolvedOsrsZ: getTerrainHeightInterpolated(heights, DUKE_MOUTH_X, DUKE_MOUTH_Y),
            heightOffset: startHeight,
          },
          target: {
            worldX,
            worldY,
            resolvedOsrsZ: getTerrainHeightInterpolated(heights, worldX, worldY),
            heightOffset: endHeight,
          },
          startOffset,
          slope,
        },
        flightCycles,
      );
      const elapsed = Math.max(0, Math.min(flightCycles, time * CYCLES_PER_TICK - launchCycle));
      const flight = advanceProjectileMotion(motion, elapsed);
      const { position, velocity } = flight;
      return {
        position: [position.x, position.y, position.z],
        yaw2048: ((Math.atan2(-velocity.x, -velocity.y) * 1024) / Math.PI + 2048) % 2048,
        pitchRad: -projectileDirection(flight).pitchRadians,
      };
    },
  };
}

export class DukePracticeEffects {
  private activeIds = new Set<string>();
  private readonly magicFlights = new Map<string, ProjectileFlight>();

  reset(): void {
    this.magicFlights.clear();
  }

  private updateMagicFlight(
    renderer: SpotAnimRenderer,
    id: string,
    windupTick: number,
    cycle: number,
    [x, y]: Coordinate,
    resolveSurfaceHeight: SurfaceHeightResolver,
  ): boolean {
    const { startCycle, endCycle, startHeight, endHeight, startOffset, slope } = DUKE_MAGIC_PROJECTILE;
    const baseCycle = windupTick * CYCLES_PER_TICK;
    if (cycle < baseCycle + startCycle || cycle >= baseCycle + endCycle) return false;

    let flight = this.magicFlights.get(id);
    if (!flight) {
      flight = new ProjectileFlight({
        instanceId: id,
        spotAnimId: DUKE_SPOT_ANIMS.magicProjectile,
        startCycle: baseCycle + startCycle,
        endCycleExclusive: baseCycle + endCycle,
        startOffset,
        slope,
        animationLoop: 'full-sequence',
        heightOffsetMode: 'sequence',
      });
      this.magicFlights.set(id, flight);
    }
    const worldX = x + 0.5;
    const worldY = y + 0.5;
    flight.update(renderer, {
      cycle,
      source: {
        worldX: DUKE_MOUTH_X,
        worldY: DUKE_MOUTH_Y,
        heightOffset: startHeight,
        resolvedOsrsZ: resolveSurfaceHeight(DUKE_MOUTH_X, DUKE_MOUTH_Y),
      },
      target: { worldX, worldY, heightOffset: endHeight, resolvedOsrsZ: resolveSurfaceHeight(worldX, worldY) },
    });
    return true;
  }

  update(
    renderer: SpotAnimRenderer,
    visuals: DukePracticeVisuals,
    time: number,
    playerVisualPosition: Coordinate,
    resolveSurfaceHeight: SurfaceHeightResolver = () => 0,
  ): void {
    const cycle = time * CYCLES_PER_TICK;
    const activeIds = new Set<string>();
    const playProjectile = (
      instanceId: string,
      spotAnimId: number,
      tile: Coordinate,
      windupTick: number | undefined,
      landingTick: number,
      projectile: DukeProjectile,
    ) => {
      if (windupTick === undefined) {
        // Older snapshots omit the windup tick and use a two-tick flight.
        if (time < landingTick - 2 || time >= landingTick) return;
        renderer.upsert({
          instanceId,
          spotAnimId,
          transform: fromDuke(tile, landingTick, 2),
          lifecycle: { kind: 'duration', startTick: landingTick - 2, endTick: landingTick },
          projectile: true,
        });
        activeIds.add(instanceId);
        return;
      }
      const launchCycle = windupTick * CYCLES_PER_TICK + projectile.startCycle;
      const endCycle = windupTick * CYCLES_PER_TICK + projectile.endCycle;
      if (cycle < launchCycle || cycle >= endCycle) return;
      const frameCycles = renderer.getFrameLengths(spotAnimId)?.reduce((sum, length) => sum + length, 0);
      renderer.upsert({
        instanceId,
        spotAnimId,
        transform: projectileTo(tile, launchCycle, projectile),
        lifecycle: {
          kind: 'duration',
          startTick: launchCycle / CYCLES_PER_TICK,
          endTick: endCycle / CYCLES_PER_TICK,
        },
        projectile: true,
        ...(frameCycles ? { frameProgress: (cycle - launchCycle) / frameCycles } : {}),
      });
      activeIds.add(instanceId);
    };
    const pose = visuals.pose;
    if (pose?.clip === 'bile') {
      playProjectile(
        `duke-bile-projectile-${pose.startTick}`,
        DUKE_SPOT_ANIMS.bileProjectile,
        playerVisualPosition,
        pose.startTick,
        pose.startTick + DUKE_BILE_PROJECTILE.endCycle / CYCLES_PER_TICK,
        DUKE_BILE_PROJECTILE,
      );
    }
    const ventClouds = new Map<string, { tile: Coordinate; startTick: number; idleTick: number; endTick: number }>();
    const play = (instanceId: string, spotAnimId: number, position: Coordinate, startTick: number) => {
      const status = updateOneShotSpotAnim(
        renderer,
        {
          instanceId,
          spotAnimId,
          startCycle: startTick * CYCLES_PER_TICK,
          transformSource: atGroundPosition(position),
          heightOffsetMode: 'sequence',
          fallbackDurationCycles: CYCLES_PER_TICK,
        },
        cycle,
      );
      if (status === 'active') activeIds.add(instanceId);
    };

    for (const { tile, tick } of visuals.orbBursts ?? []) {
      play(`duke-orb-burst-${tick}`, DUKE_SPOT_ANIMS.orbBurst, tile, tick);
    }

    for (const hazard of [...visuals.hazards, ...(visuals.fadingEffects ?? [])]) {
      const { kind, impactTick, expiresTick, tiles, landingTick = impactTick, windupTick } = hazard;
      const id = `duke-${kind}-${impactTick}`;
      if (kind === 'spikes') {
        // Cache graphic 2439 has its frontal offset baked relative to the NPC's center.
        play(`${id}-rise`, DUKE_SPOT_ANIMS.npcIcicles, DUKE_CENTER_TILE, impactTick);
        SLAM_TILES.forEach((tile, index) => {
          play(`${id}-tile-${index}`, GROUND_ICICLES[index], tile, impactTick);
        });
      } else if (kind === 'magic') {
        if (time < landingTick) {
          if (windupTick === undefined) {
            playProjectile(
              id,
              DUKE_SPOT_ANIMS.magicProjectile,
              playerVisualPosition,
              windupTick,
              landingTick,
              DUKE_MAGIC_PROJECTILE,
            );
          } else if (
            this.updateMagicFlight(renderer, id, windupTick, cycle, playerVisualPosition, resolveSurfaceHeight)
          ) {
            activeIds.add(id);
          }
        } else if (!hazard.missed) {
          // The impact is attached to the player in 20261127-002024-Duke-Sucellus_1.jsonl:8637.
          play(`${id}-impact`, DUKE_SPOT_ANIMS.magicImpact, playerVisualPosition, impactTick);
        }
      } else if (kind === 'vent' || kind === 'gasSpit') {
        const tile = kind === 'vent' ? tiles[4] : tiles[0];
        if (time < landingTick) {
          playProjectile(id, DUKE_SPOT_ANIMS.spitProjectile, tile, windupTick, landingTick, DUKE_VENT_PROJECTILE);
        } else if (kind === 'vent') {
          const key = `duke-vent-cloud-${tile[0]}-${tile[1]}`;
          const cloud = ventClouds.get(key);
          if (!cloud || landingTick >= cloud.startTick) {
            const spawnTicks = windupTick === undefined ? DUKE_VENT_SMOKE_CYCLE_TICKS : DUKE_VENT_ARM_TICKS;
            ventClouds.set(key, {
              tile,
              startTick: landingTick,
              idleTick: landingTick + spawnTicks,
              endTick: expiresTick,
            });
          }
        }
      }
    }
    for (const [id, { tile, startTick, idleTick, endTick }] of ventClouds) {
      if (time >= endTick) {
        play(`${id}-end`, DUKE_SPOT_ANIMS.ventDespawn, tile, endTick);
      } else if (time < idleTick) {
        play(`${id}-spawn`, DUKE_SPOT_ANIMS.ventSpawn, tile, startTick);
      } else {
        const idleId = `${id}-idle`;
        renderer.upsert({
          instanceId: idleId,
          spotAnimId: DUKE_SPOT_ANIMS.ventIdle,
          transform: atGroundPosition(tile),
          lifecycle: { kind: 'duration', startTick: idleTick, endTick },
          // Sequence 10196 is marked one-shot in the cache. Repeat it while the vent is active.
          frameProgress: ((time - idleTick) % DUKE_VENT_SMOKE_CYCLE_TICKS) / DUKE_VENT_SMOKE_CYCLE_TICKS,
          heightOffsetMode: 'sequence',
        });
        activeIds.add(idleId);
      }
    }
    for (const id of this.activeIds) {
      if (!activeIds.has(id)) {
        renderer.despawn(id);
        this.magicFlights.delete(id);
      }
    }
    this.activeIds = activeIds;
  }
}
