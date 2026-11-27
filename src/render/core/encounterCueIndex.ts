import {
  type EncounterClipCue,
  type EncounterGraphicCue,
  isEncounterVisualEvent,
  type NpcProjectileCue,
} from '../../core/events/encounterVisual';
import type { GameEvent } from '../../core/events/types';
import type { AnimClipRef } from '../npc/animationTypes';
import { type ReplayCue, ReplayCueStream } from './replayCueStream';
import { ReplayDeferredPrimaryIndex } from './replayDeferredPrimaryIndex';
import type { ReplayEffectDestination } from './replayEffectIndex';

/** A cue's identity: its batch, its family and its ordinal there. Shared by live and replayed play. */
export const encounterCueId = (eventId: number, family: 'projectile' | 'graphic', ordinal: number): string =>
  `cue-${eventId}-${family}-${ordinal}`;

/**
 * Every `encounter_visual` batch of a replay history, appended in the effect index's one pass over
 * its frames. A destination owns the cues emitted through its source-frame cutoff and destination
 * cycle, pending ones included, so a restore can hand cues that have not started yet to live play.
 *
 * Clips are kept twice: as one deferred primary timeline per actor, which restores a pose at any
 * cycle with same-cycle priority and the actor's spawn as its life boundary, and as a plain stream of
 * the clips still to start, for live play after a handoff.
 */
export class EncounterCueIndex {
  private readonly seenEvents = new Set<number>();
  private readonly flights = new ReplayCueStream<NpcProjectileCue>();
  private readonly graphics = new Map<number, ReplayCueStream<EncounterGraphicCue>>();
  private readonly animations = new ReplayCueStream<EncounterClipCue>();
  private readonly actors = new Map<string, ReplayDeferredPrimaryIndex<AnimClipRef>>();
  private order = 0;

  append(events: readonly GameEvent[], frameIndex: number): void {
    for (const event of events) {
      if (this.seenEvents.has(event.eventId) || !isEncounterVisualEvent(event)) continue;
      this.seenEvents.add(event.eventId);
      for (const [ordinal, cue] of event.projectiles.entries()) {
        // A zero-length flight is over before it starts: its end is exclusive.
        if (cue.startDelayCycles === cue.endDelayCycles) continue;
        const id = encounterCueId(event.eventId, 'projectile', ordinal);
        this.flights.append({ id, cue, frameIndex, tick: event.tick, order: this.order++ }, cue.endDelayCycles);
      }
      for (const [ordinal, cue] of event.graphics.entries()) {
        let stream = this.graphics.get(cue.spotAnimId);
        if (!stream) {
          stream = new ReplayCueStream();
          this.graphics.set(cue.spotAnimId, stream);
        }
        const id = encounterCueId(event.eventId, 'graphic', ordinal);
        stream.append({ id, cue, frameIndex, tick: event.tick, order: this.order++ }, cue.delayCycles);
      }
      const actors = new Map<string, Array<{ cycle: number; clipId: string }>>();
      for (const cue of event.animations) {
        this.animations.append({ id: '', cue, frameIndex, tick: event.tick, order: this.order++ }, cue.delayCycles);
        const cues = actors.get(cue.actorId) ?? [];
        cues.push({ cycle: event.tick * 30 + cue.delayCycles, clipId: cue.clipId });
        actors.set(cue.actorId, cues);
      }
      for (const [actorId, cues] of actors) {
        let timeline = this.actors.get(actorId);
        if (!timeline) {
          timeline = new ReplayDeferredPrimaryIndex();
          this.actors.set(actorId, timeline);
        }
        timeline.append(frameIndex, event.tick, cues);
      }
    }
  }

  /** Flights launched or still to launch at the destination; each ends, exclusively, at its arrival. */
  projectiles(destination: ReplayEffectDestination): readonly ReplayCue<NpcProjectileCue>[] {
    return this.flights.unexpired(destination, (cue) => cue.endDelayCycles);
  }

  /** Graphics pending or playing at the destination, in emission order. `duration` is per asset. */
  activeGraphics(
    destination: ReplayEffectDestination,
    duration: (spotAnimId: number) => number,
  ): readonly ReplayCue<EncounterGraphicCue>[] {
    const result: ReplayCue<EncounterGraphicCue>[] = [];
    for (const [spotAnimId, stream] of this.graphics) {
      const lifetime = duration(spotAnimId);
      stream.collectUnexpired(destination, (cue) => cue.delayCycles + lifetime, lifetime, result);
    }
    return result.sort((left, right) => left.order - right.order);
  }

  /** Clips owed but not started at the destination, with their start cycles, in emission order. */
  pendingAnimations(destination: ReplayEffectDestination): { cue: EncounterClipCue; cycle: number }[] {
    return this.animations
      .pending(destination, (cue) => cue.delayCycles)
      .map((entry) => ({ cue: entry.cue, cycle: entry.tick * 30 + entry.cue.delayCycles }));
  }

  primaryTimeline(actorId: string): ReplayDeferredPrimaryIndex<AnimClipRef> | undefined {
    return this.actors.get(actorId);
  }
}
