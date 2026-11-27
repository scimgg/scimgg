import { isYamaSnapshot } from '../../core/encounters/snapshot';
import type { GameEvent } from '../../core/events/types';
import type { ReplayDisplayFrame } from '../../core/ReplayRecorder';
import type { SimulationState } from '../../types/simulation';
import type { ReplayEffectDestination, ReplayFrameReader } from '../core/replayEffectIndex';
import { type PrimaryCue, ReplayPrimaryIndex } from '../core/replayPrimaryIndex';
import { VOID_FLARE_EXPLOSION_DURATION_TICKS } from '../effects/controllers/VoidFlareController';
import { describeYamaAttack, type YamaAttackDescriptor } from '../effects/controllers/YamaAttackController';
import type { AnimClipRef } from '../npc/animationTypes';
import type { NpcAnimationTrigger } from '../npc/NpcInstanceManager';

/**
 * Yama's body trigger for the snapshot's tick, live and in replay. Non-melee reserves the primary now
 * with an internal delay, the packet's `delay=30` on Yama's animation; melee plays the secondary clip
 * at once.
 */
export function describeYamaPrimaries(state: SimulationState): Array<NpcAnimationTrigger & { readonly tick: number }> {
  const snapshot = state.encounter;
  if (!isYamaSnapshot(snapshot)) return [];
  const { lastAttackKind: kind, lastAttackTick: tick } = snapshot.state;
  if (!kind || tick !== state.currentTick) return [];
  if (kind === 'melee_crush')
    return state.mechanicsConfig?.yamaMelee === false
      ? []
      : [{ actorId: 'primary-npc', trigger: 'attack', tick, clipId: 'secondary' }];
  if (kind === 'fireball' ? state.mechanicsConfig?.fireballs === false : state.mechanicsConfig?.yamaMageRange === false)
    return [];
  return [{ actorId: 'primary-npc', trigger: 'attack', tick, durationGameTicks: 3, delayClientTicks: 30 }];
}

type Entry<Value> = { readonly frameIndex: number; readonly tick: number; readonly value: Value };

/** Entries emitted through the destination: those of included frames at or (unless `inclusive`) before its cycle. */
function upperBound<Value>(entries: readonly Entry<Value>[], destination: ReplayEffectDestination, inclusive = true) {
  let lower = 0;
  let upper = entries.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const entry = entries[middle];
    if (
      entry &&
      entry.frameIndex <= destination.throughFrameIndex &&
      (inclusive ? entry.tick * 30 <= destination.cycle : entry.tick * 30 < destination.cycle)
    )
      lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

/**
 * Yama's part of a replay history, read in the shared effect index's single append pass: his body
 * triggers, his latest cast and impact, and the void flares' explosions and destructions.
 */
export class YamaReplayIndex implements ReplayFrameReader {
  private readonly primaries: PrimaryCue<NpcAnimationTrigger>[] = [];
  readonly primaryTimeline = new ReplayPrimaryIndex<NpcAnimationTrigger, AnimClipRef>(this.primaries);
  private readonly attacks: Entry<YamaAttackDescriptor>[] = [];
  private readonly flareEvents: Entry<GameEvent>[] = [];

  append(frame: ReplayDisplayFrame, frameIndex: number): void {
    for (const cue of describeYamaPrimaries(frame.state))
      this.primaries.push({ frameIndex, tick: frame.state.currentTick, value: cue });
    for (const event of frame.events) {
      const attack = describeYamaAttack(event);
      if (attack) this.attacks.push({ frameIndex, tick: event.tick, value: attack });
      if (event.type === 'voidflare_exploded' || event.type === 'voidflare_destroyed')
        this.flareEvents.push({ frameIndex, tick: event.tick, value: event });
    }
  }

  latestAttack(destination: ReplayEffectDestination): YamaAttackDescriptor | undefined {
    return this.attacks[upperBound(this.attacks, destination) - 1]?.value;
  }

  /** Explosions and destructions emitted through the destination, within an explosion's length of it. */
  recentFlareEvents(destination: ReplayEffectDestination): readonly GameEvent[] {
    const end = upperBound(this.flareEvents, destination);
    const start = upperBound(
      this.flareEvents,
      { ...destination, cycle: destination.cycle - VOID_FLARE_EXPLOSION_DURATION_TICKS * 30 },
      false,
    );
    return this.flareEvents.slice(start, end).map((entry) => entry.value);
  }
}
