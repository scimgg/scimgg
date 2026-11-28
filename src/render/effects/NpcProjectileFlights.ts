import type { NpcProjectileCue, NpcVisualTarget } from '../../core/events/encounterVisual';
import type { Coordinate } from '../../types/simulation';
import type { ReplayActorSampler } from '../core/replayActorHistory';
import { getTerrainHeightInterpolated } from '../shared/renderUtils';
import type { SurfaceHeightResolver } from './controllers/ProjectileController';
import { ProjectileFlight, type ProjectileFlightFrame, type ProjectileFlightRenderer } from './ProjectileFlight';
import type { ActorVisualPositionResolver } from './projectileAim';
import { ReplayProjectileWork } from './replayProjectileWork';

export type EncounterEffectFilter = (spotAnimId: number, tick: number) => boolean;

export type NpcProjectileFrame = {
  readonly cycle: number;
  readonly resolveActor: ActorVisualPositionResolver;
  readonly terrainHeights: Int32Array[] | null;
  readonly resolveSurfaceHeight?: SurfaceHeightResolver;
};

type Flight = {
  readonly cue: NpcProjectileCue;
  readonly runtime: ProjectileFlight;
  lastKnownTarget: Coordinate | null;
};

/** World-space center of a cue target; an actor target follows its rendered position. */
export function npcVisualTargetCentre(target: NpcVisualTarget, resolveActor: ActorVisualPositionResolver): Coordinate {
  switch (target.kind) {
    case 'actor':
      return actorCentre(target, resolveActor(target.actorId) ?? target.position);
    case 'tile':
      return [target.position[0] + 0.5, target.position[1] + 0.5];
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

function actorCentre(target: { readonly size: number }, position: Readonly<Coordinate>): Coordinate {
  return [position[0] + target.size / 2, position[1] + target.size / 2];
}

/**
 * The in-flight NPC projectiles one encounter controller owns, drawn through the shared
 * `ProjectileFlight`. Owners decide which cues exist (live events or a replay index); this class
 * only flies them, homing each on its target and replaying historical motion when sampled.
 */
export class NpcProjectileFlights {
  private readonly flights = new Map<string, Flight>();

  constructor(private readonly renderer: ProjectileFlightRenderer) {}

  get size(): number {
    return this.flights.size;
  }

  has(instanceId: string): boolean {
    return this.flights.has(instanceId);
  }

  ids(): IterableIterator<string> {
    return this.flights.keys();
  }

  /** `baseCycle` is the emitting tick's cycle; the cue's delays are relative to it. */
  add(instanceId: string, cue: NpcProjectileCue, baseCycle: number): void {
    this.flights.set(instanceId, {
      cue,
      lastKnownTarget: null,
      runtime: new ProjectileFlight({
        instanceId,
        spotAnimId: cue.spotAnimId,
        startCycle: baseCycle + cue.startDelayCycles,
        // Packet endtime is the arrival and expiry boundary:
        // docs/architecture/projectile-motion.md#inputs-and-lifetime-boundary.
        endCycleExclusive: baseCycle + cue.endDelayCycles,
        startOffset: cue.startOffset,
        slope: cue.slope,
        animationLoop: 'frame-step',
        heightOffsetMode: 'actor',
      }),
    });
  }

  delete(instanceId: string): void {
    this.renderer.despawn(instanceId);
    this.flights.delete(instanceId);
  }

  /** Prunes effects whose encounter-owned hazard has ended, including flights yet to launch. */
  retain(filter: EncounterEffectFilter): void {
    for (const [id, { cue, runtime }] of this.flights) {
      const tick = (runtime.config.startCycle - cue.startDelayCycles) / 30;
      if (!filter(cue.spotAnimId, tick)) this.delete(id);
    }
  }

  /** With a replay `sampler`, each flight is re-flown from history rather than from the live frame. */
  update(
    frame: NpcProjectileFrame,
    sampler: ReplayActorSampler | undefined,
    replayWork = new ReplayProjectileWork(),
  ): void {
    for (const [id, flight] of this.flights) {
      const status = sampler
        ? flight.runtime.updateReplay(
            this.renderer,
            frame.cycle,
            (cycle) => {
              const lastKnownTarget = flight.lastKnownTarget;
              const sample = this.flightFrame(flight, { ...frame, cycle, resolveActor: sampler(cycle, cycle) });
              if (!Number.isInteger(cycle - flight.runtime.config.startCycle)) flight.lastKnownTarget = lastKnownTarget;
              return sample;
            },
            replayWork,
          )
        : flight.runtime.update(this.renderer, this.flightFrame(flight, frame));
      if (status === 'expired') this.flights.delete(id);
    }
  }

  clear(): void {
    for (const id of this.flights.keys()) this.renderer.despawn(id);
    this.flights.clear();
  }

  private flightFrame(flight: Flight, frame: NpcProjectileFrame): ProjectileFlightFrame {
    const { cue } = flight;
    const source = cue.sourcePosition;
    const target = this.targetCentre(flight, frame);
    return {
      cycle: frame.cycle,
      source: {
        worldX: source[0],
        worldY: source[1],
        heightOffset: cue.startHeight,
        resolvedOsrsZ:
          frame.resolveSurfaceHeight?.(source[0], source[1]) ??
          getTerrainHeightInterpolated(frame.terrainHeights, source[0], source[1]),
      },
      target: {
        worldX: target[0],
        worldY: target[1],
        heightOffset: cue.endHeight,
        resolvedOsrsZ:
          frame.resolveSurfaceHeight?.(target[0], target[1]) ??
          getTerrainHeightInterpolated(frame.terrainHeights, target[0], target[1]),
      },
    };
  }

  /** Once an actor target stops resolving, a flight aims where it last saw it in flight. */
  private targetCentre(flight: Flight, frame: NpcProjectileFrame): Coordinate {
    const { target } = flight.cue;
    if (target.kind !== 'actor') return npcVisualTargetCentre(target, frame.resolveActor);
    const sampled = frame.resolveActor(target.actorId);
    const { startCycle, endCycleExclusive } = flight.runtime.config;
    if (sampled && frame.cycle >= startCycle && frame.cycle < endCycleExclusive)
      flight.lastKnownTarget = [sampled[0], sampled[1]];
    return actorCentre(target, sampled ?? flight.lastKnownTarget ?? target.position);
  }
}
