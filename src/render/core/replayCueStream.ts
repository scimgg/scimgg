import type { ActorCueLife } from './actorCueLife';
import type { ReplayEffectDestination } from './replayEffectIndex';

/** One cue as emitted on a recorded frame. Encounter indexes own the cue data and its id. */
export type ReplayCue<Cue> = {
  readonly id: string;
  readonly cue: Cue;
  readonly frameIndex: number;
  /** The emitting tick. Cue delays count client cycles from its start. */
  readonly tick: number;
  readonly order: number;
  /** The life of the actor an actor-bound cue (a clip, an `attached` graphic) rides; see `ActorCueLife`. */
  readonly life?: ActorCueLife;
};

/**
 * One kind of delayed visual cue from a replay history, appended in frame order.
 *
 * A destination owns exactly the cues emitted through its frame cutoff and cycle, including those
 * whose delayed start is still ahead of it. Holding the unstarted ones lets a restored presentation
 * hand them to live play, which never sees their events again. Deriving every answer from the
 * destination keeps rewinds and held frames from showing a later frame's cues.
 */
export class ReplayCueStream<Cue> {
  private readonly entries: ReplayCue<Cue>[] = [];
  private maximumLifetimeCycles = 0;

  /**
   * `lifetimeCycles` bounds how long after its emitting tick this cue can start or stay in effect,
   * apart from any duration the renderer resolves later.
   */
  append(entry: ReplayCue<Cue>, lifetimeCycles: number): void {
    this.entries.push(entry);
    this.maximumLifetimeCycles = Math.max(this.maximumLifetimeCycles, lifetimeCycles);
  }

  /** Owed cues that have not started yet at the destination, in emission order. */
  pending(destination: ReplayEffectDestination, startDelay: (cue: Cue) => number): ReplayCue<Cue>[] {
    return this.unexpired(destination, startDelay);
  }

  /**
   * Owed cues still pending or in effect at the destination, in emission order. `endDelay` is when a
   * cue ends after its emitting tick; `extraLifetimeCycles` covers any part of it not given to `append`.
   */
  unexpired(
    destination: ReplayEffectDestination,
    endDelay: (cue: Cue) => number,
    extraLifetimeCycles = 0,
  ): ReplayCue<Cue>[] {
    const result: ReplayCue<Cue>[] = [];
    this.collectUnexpired(destination, endDelay, extraLifetimeCycles, result);
    return result;
  }

  /**
   * Appends {@link unexpired}'s cues to `into`, one at a time: a stream can hold more cues than a call
   * can take arguments, so its cues are never spread.
   */
  collectUnexpired(
    destination: ReplayEffectDestination,
    endDelay: (cue: Cue) => number,
    extraLifetimeCycles: number,
    into: ReplayCue<Cue>[],
  ): void {
    const earliest = destination.cycle - this.maximumLifetimeCycles - extraLifetimeCycles;
    const end = this.upperBound(destination);
    for (let index = this.upperBound({ ...destination, cycle: earliest }); index < end; index++) {
      const entry = this.entries[index];
      if (entry.tick * 30 + endDelay(entry.cue) > destination.cycle) into.push(entry);
    }
  }

  /** Entries are appended in frame and tick order, so emission through a destination is a prefix. */
  private upperBound(destination: ReplayEffectDestination): number {
    let lower = 0;
    let upper = this.entries.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      const entry = this.entries[middle];
      if (entry.frameIndex <= destination.throughFrameIndex && entry.tick * 30 <= destination.cycle) lower = middle + 1;
      else upper = middle;
    }
    return lower;
  }
}
