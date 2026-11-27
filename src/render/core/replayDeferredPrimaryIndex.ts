import type { ActorCueLife } from './actorCueLife';
import type { ReplayEffectDestination } from './replayEffectIndex';
import { canReplacePrimary, type PrimarySample, type PrimarySpec, primaryPhase } from './replayPrimaryIndex';

/** A clip due on the actor at `cycle`, for the actor's `life` when it was emitted for one. */
type DeferredCue = { readonly cycle: number; readonly clipId: string; readonly life?: ActorCueLife };
type Source = { readonly frameIndex: number; readonly tick: number; readonly cues: readonly DeferredCue[] };
type Timed<Clip> = { readonly cycle: number; readonly spec: PrimarySpec<Clip>; readonly life?: ActorCueLife };
type Sweep<Clip> = {
  readonly cues: Timed<Clip>[];
  sourceCursor: number;
  dueCursor: number;
  current: Timed<Clip> | undefined;
  /** The earliest cue that has become due on a life still lasting: the base pose's origin. */
  first: Timed<Clip> | undefined;
  cycle: number;
  throughFrameIndex: number;
};
type Life<Clip> = {
  readonly metadata: object;
  readonly clips: Map<string, PrimarySpec<Clip> | null>;
  sweep: Sweep<Clip>;
  pending: boolean;
};
export type ReplayActorDestination = ReplayEffectDestination & { readonly spawnTick: number };

const createSweep = <Clip>(): Sweep<Clip> => ({
  cues: [],
  sourceCursor: 0,
  dueCursor: 0,
  current: undefined,
  first: undefined,
  cycle: -Infinity,
  throughFrameIndex: -1,
});

function sampleTimed<Clip>(timed: Timed<Clip>, cycle: number): PrimarySample<Clip> | null {
  const { clip, duration, delay } = timed.spec;
  const phase = primaryPhase(delay, cycle - timed.cycle);
  return phase.delayClientTicks === 0 && phase.elapsedTicks >= duration ? null : { clip, duration, ...phase };
}

export class ReplayDeferredPrimaryIndex<Clip> {
  private readonly sources: Source[] = [];
  private readonly lives = new Map<number, Life<Clip>>();

  append(frameIndex: number, tick: number, cues: readonly DeferredCue[]): void {
    this.sources.push({ frameIndex, tick, cues });
  }

  sample(
    destination: ReplayActorDestination,
    metadata: object,
    resolve: (clipId: string) => PrimarySpec<Clip> | null | undefined,
  ): {
    readonly primary: PrimarySample<Clip> | null;
    readonly firstCycle: number | undefined;
    readonly rebuilt: boolean;
    readonly pending: boolean;
  } {
    let life = this.lives.get(destination.spawnTick);
    const rebuilt = life?.metadata !== metadata || life?.pending === true;
    if (!life || life.metadata !== metadata) {
      life = { metadata, sweep: createSweep(), clips: new Map(), pending: false };
      this.lives.set(destination.spawnTick, life);
    }
    if (
      destination.cycle < life.sweep.cycle ||
      destination.throughFrameIndex < life.sweep.throughFrameIndex ||
      // A clip taken from a life that has ended since (an id reused with no spawn tick to tell the
      // lives apart) goes with it: the sweep is rebuilt without it.
      life.sweep.current?.life?.isEndedBy(destination) ||
      life.sweep.first?.life?.isEndedBy(destination)
    ) {
      life.sweep = createSweep();
    }
    const sweep = life.sweep;
    const previousCueCount = sweep.cues.length;
    life.pending = false;
    for (; sweep.sourceCursor < this.sources.length; sweep.sourceCursor++) {
      const source = this.sources[sweep.sourceCursor];
      if (source.frameIndex > destination.throughFrameIndex || source.tick * 30 > destination.cycle) break;
      const incoming: Timed<Clip>[] = [];
      for (const cue of source.cues) {
        if (cue.cycle < destination.spawnTick * 30 || cue.life?.isEndedBy(destination)) continue;
        let spec = life.clips.get(cue.clipId);
        if (spec === undefined) {
          spec = resolve(cue.clipId);
          if (spec !== undefined) life.clips.set(cue.clipId, spec);
        }
        if (spec === undefined) {
          life.pending = true;
          break;
        }
        if (spec) incoming.push({ cycle: cue.cycle, spec, life: cue.life });
      }
      if (life.pending) break;
      for (const cue of incoming) {
        if (cue.cycle <= sweep.cycle) {
          sweep.dueCursor = 0;
          sweep.current = undefined;
          sweep.first = undefined;
        }
        sweep.cues.push(cue);
      }
    }
    if (sweep.cues.length !== previousCueCount) sweep.cues.sort((left, right) => left.cycle - right.cycle);
    for (; sweep.dueCursor < sweep.cues.length; sweep.dueCursor++) {
      const cue = sweep.cues[sweep.dueCursor];
      if (cue.cycle > destination.cycle) break;
      // Queued while its life lasted, due once it has ended: it never plays.
      if (cue.life?.isEndedBy(destination)) continue;
      sweep.first ??= cue;
      const current = sweep.current && sampleTimed(sweep.current, cue.cycle) ? sweep.current.spec : undefined;
      if (cue.spec.replaces || canReplacePrimary(current?.priority, cue.spec.priority)) sweep.current = cue;
    }
    sweep.cycle = destination.cycle;
    sweep.throughFrameIndex = destination.throughFrameIndex;
    return {
      primary: sweep.current ? sampleTimed(sweep.current, destination.cycle) : null,
      firstCycle: sweep.first?.cycle,
      rebuilt,
      pending: life.pending,
    };
  }
}
