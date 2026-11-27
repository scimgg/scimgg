import {
  type EncounterClipCue,
  type EncounterGraphicCue,
  isEncounterVisualEvent,
} from '../../core/events/encounterVisual';
import { type GameEvent, isCoreEvent } from '../../core/events/types';
import type { NpcSnapshot } from '../../types/simulation';
import { type ActorCueLife, ActorCueLives } from '../core/actorCueLife';
import { encounterCueId } from '../core/encounterCueIndex';
import type { ReplayEffectDestination, ReplayEffectIndex } from '../core/replayEffectIndex';
import { getTerrainHeightInterpolated } from '../shared/renderUtils';
import { NpcProjectileFlights, type NpcProjectileFrame, npcVisualTargetCentre } from './NpcProjectileFlights';
import type { ProjectileFlightRenderer } from './ProjectileFlight';
import { projectileEndpoint } from './projectileMotion';
import { ReplayProjectileWork } from './replayProjectileWork';
import { getOneShotDurationCycles, OneShotSpotAnim } from './spotAnimPlayback';
import type { SpotAnimStyle, SpotAnimTransform } from './spotAnimTypes';

/** One frame's view of the scene, once every actor's rendered position is known. */
export type EncounterCueFrame = NpcProjectileFrame & {
  /** An actor's rendered model transform, or null while it is not drawn: what `attached` graphics ride. */
  readonly resolveAttachment: (actorId: string) => SpotAnimTransform | null;
};

/** A clip due to start on an actor at `cycle`, for the life of the actor it was emitted for. */
export type DueEncounterClip = { readonly cue: EncounterClipCue; readonly cycle: number; readonly life: ActorCueLife };

/** The actors a live frame shows, after its tick: what its cues' actor lives are worked out from. */
export type EncounterCueActors = { readonly npcs: readonly NpcSnapshot[]; readonly currentTick: number };

type Graphic = {
  readonly cue: EncounterGraphicCue;
  readonly start: number;
  readonly playback: OneShotSpotAnim;
  /** An `attached` graphic's actor life; see `ActorCueLife`. */
  readonly life?: ActorCueLife;
};

/**
 * Plays the scene's `encounter_visual` cues: the clips still to start, the NPC projectiles in flight
 * and the one-shot graphics on their three anchors. Owned by the scene compositor, which decides when
 * each step runs; the cue player owns none of the scene's lifecycle.
 *
 * Live play reads each batch once from the frame's events. A replay frame instead takes, from the
 * history's shared effect index, everything owed at its destination: started flights are re-flown
 * from history, graphics resume at their own start, and clips are left to the actors' primary
 * timelines, except those not yet started, which a restored presentation hands to live play.
 *
 * A clip or an `attached` graphic plays only for the life of its actor it was emitted for: the
 * actor's removal or a new spawn under its id drops it, live as in replay, and in the cues a restored
 * presentation hands over.
 */
export class EncounterCuePlayer {
  private readonly seenEvents = new Set<number>();
  private readonly flights: NpcProjectileFlights;
  private readonly graphics = new Map<string, Graphic>();
  private animations: DueEncounterClip[] = [];
  /** Live play's actor lives; in replay, the index's own lives answer at the destination. */
  private readonly lives = new ActorCueLives();
  private replay: { readonly index: ReplayEffectIndex; readonly destination: ReplayEffectDestination } | undefined;
  /** The frame the latest `update` was given; every graphic's transform resolves against it. */
  private frame: EncounterCueFrame | null = null;

  /**
   * @param graphicStyle The scene's draw policy for each graphic (depth bias, view culling); fixed for
   *   the graphic's life. Presentation, not cue data: the batch says only what plays where and when.
   */
  constructor(
    private readonly renderer: ProjectileFlightRenderer,
    private readonly graphicStyle: (cue: EncounterGraphicCue) => SpotAnimStyle | undefined = () => undefined,
  ) {
    this.flights = new NpcProjectileFlights(renderer);
  }

  /**
   * Takes each batch in `events` once, and each actor removal (`actor_despawned`) in event order with
   * them; `actors` is the frame's state. Even an empty live frame retires historical aiming.
   */
  consumeEvents(events: readonly GameEvent[], actors: EncounterCueActors): void {
    if (this.replay) this.adoptReplayLives(this.replay.destination);
    this.replay = undefined;
    this.lives.observe(actors.npcs, { frameIndex: 0, tick: actors.currentTick });
    let added = false;
    for (const event of events) {
      if (this.seenEvents.has(event.eventId)) continue;
      if (isCoreEvent(event, 'actor_despawned')) {
        this.seenEvents.add(event.eventId);
        this.lives.remove(event.actorId, { frameIndex: 0, tick: event.tick });
        continue;
      }
      if (!isEncounterVisualEvent(event)) continue;
      this.seenEvents.add(event.eventId);
      const base = event.tick * 30;
      for (const [ordinal, cue] of event.projectiles.entries())
        this.flights.add(encounterCueId(event.eventId, 'projectile', ordinal), cue, base);
      for (const [ordinal, cue] of event.graphics.entries()) {
        const id = encounterCueId(event.eventId, 'graphic', ordinal);
        const life = cue.target.kind === 'attached' ? this.lives.lifeOf(cue.target.actorId) : undefined;
        this.graphics.set(id, this.createGraphic(id, cue, base + cue.delayCycles, life));
      }
      for (const cue of event.animations) {
        this.animations.push({ cue, cycle: base + cue.delayCycles, life: this.lives.lifeOf(cue.actorId) });
        added = true;
      }
    }
    // Stable: same-cycle clips keep emission order.
    if (added) this.animations.sort((left, right) => left.cycle - right.cycle);
    this.dropEndedLives(undefined);
  }

  /**
   * Takes what the history owes at `destination` from its effect index. With `rebuild`, everything
   * held is dropped first (a seek, a new history or a restore); otherwise cues already playing keep
   * their state and only newly owed ones are added.
   */
  syncReplay(index: ReplayEffectIndex, destination: ReplayEffectDestination, rebuild: boolean): void {
    if (rebuild) this.clear();
    this.replay = { index, destination };
    for (const entry of index.cues.projectiles(destination))
      if (!this.flights.has(entry.id)) this.flights.add(entry.id, entry.cue, entry.tick * 30);
    for (const entry of index.cues.activeGraphics(destination, (id) => getOneShotDurationCycles(this.renderer, id, 0)))
      if (!this.graphics.has(entry.id))
        this.graphics.set(
          entry.id,
          this.createGraphic(entry.id, entry.cue, entry.tick * 30 + entry.cue.delayCycles, entry.life),
        );
    // Replay poses actors from their timelines; only live play after a restored handoff takes these.
    this.animations = index.cues.pendingAnimations(destination).sort((left, right) => left.cycle - right.cycle);
    this.dropEndedLives(destination);
  }

  /** The clips due by `cycle`, in start order (emission order within a cycle), removed from the queue. */
  takeAnimations(cycle: number): DueEncounterClip[] {
    let due = 0;
    while (due < this.animations.length && this.animations[due].cycle <= cycle) due++;
    return due === 0 ? [] : this.animations.splice(0, due);
  }

  /** Flies the projectiles and places the graphics for this frame's rendered positions. */
  update(frame: EncounterCueFrame, replayWork = new ReplayProjectileWork()): void {
    this.frame = frame;
    const replay = this.replay;
    const sampler = replay?.index.actors.sampler(
      { cycle: frame.cycle, throughFrameIndex: replay.destination.throughFrameIndex },
      'snapshot',
    );
    this.flights.update(frame, sampler, replayWork);
    this.graphics.forEach(({ cue, start, playback }, id) => {
      if (cue.target.kind === 'attached' && frame.resolveAttachment(cue.target.actorId) === null) {
        // Hidden while its actor is not drawn; it keeps its own clock and shows again with the actor.
        this.renderer.despawn(id);
        if (frame.cycle >= start + getOneShotDurationCycles(this.renderer, cue.spotAnimId, 0)) this.graphics.delete(id);
        return;
      }
      const status = playback.update(this.renderer, frame.cycle);
      switch (status) {
        case 'expired':
          this.graphics.delete(id);
          break;
        case 'unloaded':
          // An effect still unloaded once it should have started is dropped, not shown late.
          if (frame.cycle >= start) this.graphics.delete(id);
          break;
        case 'pending':
        case 'active':
          break;
        default: {
          const exhaustive: never = status;
          throw exhaustive;
        }
      }
    });
  }

  clear(): void {
    this.flights.clear();
    for (const id of this.graphics.keys()) this.renderer.despawn(id);
    this.graphics.clear();
    this.animations = [];
    this.lives.clear();
    this.seenEvents.clear();
    this.replay = undefined;
  }

  /**
   * Drops the clips still to start and the graphics riding an actor whose life ended by `destination`
   * (live: by now). Flights and graphics merely aimed at the actor play on.
   */
  private dropEndedLives(destination: ReplayEffectDestination | undefined): void {
    this.animations = this.animations.filter(({ life }) => !life.isEndedBy(destination));
    this.graphics.forEach(({ life }, id) => {
      if (!life?.isEndedBy(destination)) return;
      this.renderer.despawn(id);
      this.graphics.delete(id);
    });
  }

  /**
   * Live play takes over from a replayed destination (a restored presentation's handoff): the clips
   * and graphics it holds carry on with live copies of their actor lives as they stood there.
   */
  private adoptReplayLives(destination: ReplayEffectDestination): void {
    this.lives.clear();
    const adopted = new Map<ActorCueLife, ActorCueLife>();
    this.animations = this.animations.flatMap((clip) => {
      const life = this.lives.adopt(clip.cue.actorId, clip.life, destination, adopted);
      return life ? [{ ...clip, life }] : [];
    });
    this.graphics.forEach((graphic, id) => {
      if (!graphic.life || graphic.cue.target.kind !== 'attached') return;
      const life = this.lives.adopt(graphic.cue.target.actorId, graphic.life, destination, adopted);
      if (life) this.graphics.set(id, { ...graphic, life });
      else {
        this.renderer.despawn(id);
        this.graphics.delete(id);
      }
    });
  }

  /** The graphic's playback, its transform resolved into one record of its own whenever it is drawn. */
  private createGraphic(id: string, cue: EncounterGraphicCue, start: number, life?: ActorCueLife): Graphic {
    const transform: SpotAnimTransform = { position: [0, 0, 0] };
    const resolve = (): SpotAnimTransform | null => {
      const frame = this.frame;
      if (!frame) return null;
      const { target } = cue;
      if (target.kind === 'attached') {
        const actor = frame.resolveAttachment(target.actorId);
        if (!actor) return null;
        transform.position[0] = actor.position[0];
        transform.position[1] = actor.position[1];
        transform.position[2] = actor.position[2] + cue.height / 128;
        transform.yaw2048 = actor.yaw2048;
        transform.pitchRad = actor.pitchRad;
        transform.scale = actor.scale;
        return transform;
      }
      const [x, y] = npcVisualTargetCentre(target, frame.resolveActor);
      const point = projectileEndpoint({
        worldX: x,
        worldY: y,
        heightOffset: cue.height,
        resolvedOsrsZ: getTerrainHeightInterpolated(frame.terrainHeights, x, y),
      });
      transform.position[0] = point.x;
      transform.position[1] = point.y;
      transform.position[2] = point.z;
      return transform;
    };
    const playback = new OneShotSpotAnim({
      instanceId: id,
      spotAnimId: cue.spotAnimId,
      startCycle: start,
      transformSource: { kind: 'dynamic', resolve },
      style: this.graphicStyle(cue),
      heightOffsetMode: 'actor',
      fallbackDurationCycles: 0,
    });
    return { cue, start, playback, life };
  }
}
