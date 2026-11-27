import type { NpcProjectileCue } from '../../../core/events/encounterVisual';
import type { GameEvent } from '../../../core/events/types';
import type { ReplayDisplayFrame } from '../../../core/ReplayRecorder';
import { COLOSSEUM_SPOTANIMS } from '../../../npcs/colosseum/constants';
import {
  type ColosseumAnimationCue,
  type ColosseumGraphicCue,
  isColosseumVisualEvent,
} from '../../../npcs/colosseum/visualEvents';
import type { ReplayActorSampler } from '../../core/replayActorHistory';
import { ReplayCueStream } from '../../core/replayCueStream';
import { ReplayDeferredPrimaryIndex } from '../../core/replayDeferredPrimaryIndex';
import type { AnimClipRef } from '../../npc/animationTypes';
import type { RenderContext } from '../../scene/types';
import { getTerrainHeightInterpolated } from '../../shared/renderUtils';
import { NpcProjectileFlights, type NpcProjectileFrame } from '../NpcProjectileFlights';
import type { ProjectileFlightRenderer } from '../ProjectileFlight';
import type { ReplayProjectileWork } from '../replayProjectileWork';
import { getOneShotDurationCycles, OneShotSpotAnim } from '../spotAnimPlayback';
import { FLOOR_EFFECT_DEPTH_BIAS } from '../spotAnimRenderPolicy';
import type { SpotAnimStyle, SpotAnimTransform } from '../spotAnimTypes';

type Animation = { readonly cue: ColosseumAnimationCue; readonly cycle: number };
/**
 * A graphic and its playback, built once and updated in place every frame. `synced` is the
 * `syncReplay` call that last found it owed.
 */
type Graphic = {
  readonly cue: ColosseumGraphicCue;
  readonly start: number;
  readonly playback: OneShotSpotAnim;
  synced: number;
};
type History = {
  count: number;
  order: number;
  readonly seen: Set<number>;
  readonly animations: ReplayCueStream<ColosseumAnimationCue>;
  readonly graphics: ReplayCueStream<ColosseumGraphicCue>;
  readonly spotAnimIds: Set<number>;
  readonly projectiles: ReplayCueStream<NpcProjectileCue>;
  readonly actors: Map<string, ReplayDeferredPrimaryIndex<AnimClipRef>>;
};

const projectileId = (eventId: number, ordinal: number) => `colosseum-${eventId}-projectile-${ordinal}`;

/** Tile effects (attack ripples, sand strikes) sit on the floor; actor effects ride Sol. */
const FLOOR_STYLE: SpotAnimStyle = { depthBias: FLOOR_EFFECT_DEPTH_BIAS };
/**
 * Sol's melee puffs (Spear and Shield) may be left out of frames whose view excludes them; the
 * compositor decides whether a view is set at all. Their timelines go on regardless.
 */
const SOL_MELEE_FLOOR_STYLE: SpotAnimStyle = { ...FLOOR_STYLE, cullOutsideView: true };
const SOL_MELEE_SPOT_ANIM_IDS: ReadonlySet<number> = new Set(COLOSSEUM_SPOTANIMS.solMelee);

export class ColosseumVisualController {
  private readonly pending: Animation[] = [];
  private readonly graphics = new Map<string, Graphic>();
  private readonly flights: NpcProjectileFlights;
  private readonly seen = new Set<number>();
  private readonly histories = new WeakMap<readonly ReplayDisplayFrame[], History>();
  private syncs = 0;
  /** What the latest `render` was given; every graphic's transform resolves against these. */
  private terrainHeights: Int32Array[] | null = null;
  private resolveActor: (actorId: string) => SpotAnimTransform | null = () => null;

  constructor(private readonly renderer: ProjectileFlightRenderer) {
    this.flights = new NpcProjectileFlights(renderer);
  }

  clear(): void {
    for (const id of this.graphics.keys()) this.renderer.despawn(id);
    this.graphics.clear();
    this.flights.clear();
    this.pending.length = 0;
    this.seen.clear();
  }

  removeActor(actorId: string): void {
    for (let index = this.pending.length - 1; index >= 0; index--) {
      if (this.pending[index].cue.actorId === actorId) this.pending.splice(index, 1);
    }
    for (const [id, { cue }] of this.graphics) {
      if ('actorId' in cue && cue.actorId === actorId) {
        this.renderer.despawn(id);
        this.graphics.delete(id);
      }
    }
  }

  consume(events: readonly GameEvent[]): void {
    for (const event of events) {
      if (!isColosseumVisualEvent(event) || this.seen.has(event.eventId)) continue;
      this.seen.add(event.eventId);
      for (const cue of event.animations) this.pending.push({ cue, cycle: event.tick * 30 + cue.delayCycles });
      for (const [ordinal, cue] of event.graphics.entries()) {
        const id = `colosseum-${event.eventId}-${ordinal}`;
        this.graphics.set(id, this.createGraphic(id, cue, event.tick * 30 + cue.delayCycles));
      }
      for (const [ordinal, cue] of (event.projectiles ?? []).entries())
        this.flights.add(projectileId(event.eventId, ordinal), cue, event.tick * 30);
    }
    this.pending.sort((left, right) => left.cycle - right.cycle);
  }

  takeAnimations(cycle: number): Animation[] {
    const firstFuture = this.pending.findIndex((entry) => entry.cycle > cycle);
    return this.pending.splice(0, firstFuture < 0 ? this.pending.length : firstFuture);
  }

  syncReplay(
    history: NonNullable<RenderContext['replayHistory']>,
    cycle: number,
  ): ReadonlyMap<string, ReplayDeferredPrimaryIndex<AnimClipRef>> {
    let index = this.histories.get(history.frames);
    if (!index) {
      index = {
        count: 0,
        order: 0,
        seen: new Set(),
        animations: new ReplayCueStream(),
        graphics: new ReplayCueStream(),
        spotAnimIds: new Set(),
        projectiles: new ReplayCueStream(),
        actors: new Map(),
      };
      this.histories.set(history.frames, index);
    }
    for (; index.count <= history.throughFrameIndex && index.count < history.frames.length; index.count++) {
      const frame = history.frames[index.count];
      for (const event of frame.events) {
        if (!isColosseumVisualEvent(event) || index.seen.has(event.eventId)) continue;
        index.seen.add(event.eventId);
        const emitted = { frameIndex: index.count, tick: event.tick };
        for (const cue of event.animations) {
          let timeline = index.actors.get(cue.actorId);
          if (!timeline) {
            timeline = new ReplayDeferredPrimaryIndex();
            index.actors.set(cue.actorId, timeline);
          }
          timeline.append(index.count, event.tick, [{ cycle: event.tick * 30 + cue.delayCycles, clipId: cue.clipId }]);
          index.animations.append({ ...emitted, id: '', cue, order: index.order++ }, cue.delayCycles);
        }
        for (const [ordinal, cue] of event.graphics.entries()) {
          index.spotAnimIds.add(cue.spotAnimId);
          const id = `colosseum-${event.eventId}-${ordinal}`;
          index.graphics.append({ ...emitted, id, cue, order: index.order++ }, cue.delayCycles);
        }
        for (const [ordinal, cue] of (event.projectiles ?? []).entries()) {
          const id = projectileId(event.eventId, ordinal);
          index.projectiles.append({ ...emitted, id, cue, order: index.order++ }, cue.endDelayCycles);
        }
      }
    }
    const destination = { cycle, throughFrameIndex: history.throughFrameIndex };
    // Replay poses actors from their timelines; only live play after a restored handoff takes these.
    this.pending.length = 0;
    for (const { tick, cue } of index.animations.pending(destination, (cue) => cue.delayCycles))
      this.pending.push({ cue, cycle: tick * 30 + cue.delayCycles });
    this.pending.sort((left, right) => left.cycle - right.cycle);
    const flying = new Set<string>();
    for (const { id, cue, tick } of index.projectiles.unexpired(destination, (cue) => cue.endDelayCycles)) {
      flying.add(id);
      if (!this.flights.has(id)) this.flights.add(id, cue, tick * 30);
    }
    for (const id of [...this.flights.ids()]) if (!flying.has(id)) this.flights.delete(id);
    // Unstarted graphics are held too; render skips them until their start.
    let duration = 0;
    for (const id of index.spotAnimIds) duration = Math.max(duration, getOneShotDurationCycles(this.renderer, id, 0));
    const sync = ++this.syncs;
    for (const { id, cue, tick } of index.graphics.unexpired(
      destination,
      (cue) => cue.delayCycles + duration,
      duration,
    )) {
      const start = tick * 30 + cue.delayCycles;
      let graphic = this.graphics.get(id);
      if (graphic?.cue !== cue || graphic.start !== start) {
        graphic = this.createGraphic(id, cue, start);
        this.graphics.set(id, graphic);
      }
      graphic.synced = sync;
    }
    this.graphics.forEach((graphic, id) => {
      if (graphic.synced === sync) return;
      this.renderer.despawn(id);
      this.graphics.delete(id);
    });
    return index.actors;
  }

  /** Projectiles home on rendered actors, so they update once the player's visual tile is known. */
  updateProjectiles(
    frame: NpcProjectileFrame,
    sampler: ReplayActorSampler | undefined,
    replayWork: ReplayProjectileWork | undefined,
  ): void {
    this.flights.update(frame, sampler, replayWork);
  }

  render(
    cycle: number,
    terrainHeights: Int32Array[] | null,
    resolveActor: (actorId: string) => SpotAnimTransform | null,
  ): void {
    // The renderer resolves each graphic's transform when it draws, with what this call was given.
    this.terrainHeights = terrainHeights;
    this.resolveActor = resolveActor;
    // forEach, not for-of: a Map iterator's results are allocated wherever it is not optimized away.
    this.graphics.forEach(({ cue, playback }, id) => {
      if ('actorId' in cue && resolveActor(cue.actorId) === null) {
        this.renderer.despawn(id);
        return;
      }
      if (playback.update(this.renderer, cycle) === 'expired') this.graphics.delete(id);
    });
  }

  /** The graphic's playback, with a transform resolved into one record of its own every frame. */
  private createGraphic(id: string, cue: ColosseumGraphicCue, start: number): Graphic {
    const transform: SpotAnimTransform = { position: [0, 0, 0] };
    const height = (cue.height ?? 0) / 128;
    const resolve =
      'actorId' in cue
        ? (): SpotAnimTransform | null => {
            const actor = this.resolveActor(cue.actorId);
            if (!actor) return null;
            transform.position[0] = actor.position[0];
            transform.position[1] = actor.position[1];
            transform.position[2] = actor.position[2] + height;
            transform.yaw2048 = actor.yaw2048;
            transform.pitchRad = actor.pitchRad;
            transform.scale = actor.scale;
            return transform;
          }
        : (): SpotAnimTransform => {
            const x = cue.position[0] + 0.5;
            const y = cue.position[1] + 0.5;
            transform.position[0] = x;
            transform.position[1] = y;
            transform.position[2] =
              (-getTerrainHeightInterpolated(this.terrainHeights, x, y) + (cue.height ?? 0)) / 128;
            return transform;
          };
    const playback = new OneShotSpotAnim({
      instanceId: id,
      spotAnimId: cue.spotAnimId,
      startCycle: start,
      transformSource: { kind: 'dynamic', resolve },
      style:
        'actorId' in cue
          ? undefined
          : SOL_MELEE_SPOT_ANIM_IDS.has(cue.spotAnimId)
            ? SOL_MELEE_FLOOR_STYLE
            : FLOOR_STYLE,
      heightOffsetMode: 'actor',
      fallbackDurationCycles: 0,
    });
    return { cue, start, playback, synced: this.syncs };
  }
}
