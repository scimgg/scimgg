import { isActorPresentationsRemovedEvent } from '../../core/events/encounterVisual';
import type { GameEvent } from '../../core/events/types';
import type { ReplayDisplayFrame } from '../../core/ReplayRecorder';
import type { NpcSnapshot } from '../../types/simulation';
import { VOID_FLARE_EXPLOSION_DURATION_TICKS } from '../effects/controllers/VoidFlareController';
import { describeYamaAttack, type YamaAttackDescriptor } from '../effects/controllers/YamaAttackController';
import {
  describePlayerEffects,
  type PlayerEffectDescriptor,
  type PlayerTravelDescriptor,
  projectileEndCycle,
} from '../effects/playerEffectDescriptors';
import { type AnimClipRef, CLIENT_TICK_MS } from '../npc/animationTypes';
import type { NpcAnimationTrigger } from '../npc/NpcInstanceManager';
import { EncounterCueIndex } from './encounterCueIndex';
import { ReplayActorHistory } from './replayActorHistory';
import {
  describePlayerPrimaries,
  describeYamaPrimaries,
  type PlayerPrimaryClip,
  type PlayerPrimaryCue,
} from './replayPrimaryCues';
import { type PrimaryCue, ReplayPrimaryIndex } from './replayPrimaryIndex';

export type ReplayEffectDestination = { readonly cycle: number; readonly throughFrameIndex: number };
type Entry<Value> = {
  readonly frameIndex: number;
  readonly tick: number;
  readonly ordinal: number;
  readonly value: Value;
};
type TravelStream = { readonly entries: Entry<PlayerTravelDescriptor>[]; maximumDelayCycles: number };
export type EffectDurationResolver = (spotAnimId: number) => number | undefined;
export type ReplayDeathPresentation = { readonly npc: NpcSnapshot; readonly elapsedMs: number };
type ActorLife = { readonly key: number; readonly spawnTick: number | undefined; present: boolean };
type DeathPresentationRecord = {
  readonly frameIndex: number;
  readonly deathCycle: number;
  readonly lifeKey: number;
  readonly npc: NpcSnapshot;
};

function upperBound<Value>(
  entries: readonly Entry<Value>[],
  destination: ReplayEffectDestination,
  inclusive = true,
): number {
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

export class ReplayEffectIndex {
  readonly actors = new ReplayActorHistory();
  /** Every encounter visual batch: the scene's cue player restores clips, flights and graphics from it. */
  readonly cues = new EncounterCueIndex();
  readonly playerPrimaries: PrimaryCue<PlayerPrimaryCue>[] = [];
  readonly yamaPrimaries: PrimaryCue<NpcAnimationTrigger>[] = [];
  readonly playerPrimaryTimeline = new ReplayPrimaryIndex<PlayerPrimaryCue, PlayerPrimaryClip>(this.playerPrimaries);
  readonly yamaPrimaryTimeline = new ReplayPrimaryIndex<NpcAnimationTrigger, AnimClipRef>(this.yamaPrimaries);
  private indexedLength = 0;
  private readonly graphics: Entry<PlayerEffectDescriptor>[] = [];
  private readonly travel = new Map<number, TravelStream>();
  private readonly yamaAttacks: Entry<YamaAttackDescriptor>[] = [];
  private readonly flareEvents: Entry<GameEvent>[] = [];
  private readonly actorLives = new Map<string, ActorLife>();
  private presentActorIds = new Set<string>();
  private readonly deathsByLife = new Map<number, DeathPresentationRecord>();
  private readonly deathRecords: DeathPresentationRecord[] = [];
  private readonly deathSuppressions = new Map<number, Entry<undefined>>();
  /** Each NPC type's `actor_presentations_removed` events, in frame order. */
  private readonly typeRemovals = new Map<number, Entry<undefined>[]>();
  private nextLifeKey = 0;

  constructor(readonly frames: readonly ReplayDisplayFrame[]) {
    this.extend();
  }

  extend(): void {
    for (; this.indexedLength < this.frames.length; this.indexedLength++) {
      const source = this.frames[this.indexedLength];
      // Each frame's events are read once, however many indexes consume them.
      const frame = { state: source.state, events: source.events };
      this.cues.append(frame.events, this.indexedLength);
      this.actors.append(frame, this.indexedLength);
      const presentActorIds = new Set<string>();
      for (const npc of frame.state.npcs) {
        presentActorIds.add(npc.id);
        const previousLife = this.actorLives.get(npc.id);
        const sameLife =
          previousLife !== undefined &&
          (npc.spawnTick !== undefined ? previousLife.spawnTick === npc.spawnTick : previousLife.present);
        const life = sameLife ? previousLife : { key: this.nextLifeKey++, spawnTick: npc.spawnTick, present: true };
        life.present = true;
        this.actorLives.set(npc.id, life);
        if (!npc.alive && !this.deathsByLife.has(life.key)) {
          const record = {
            frameIndex: this.indexedLength,
            deathCycle: (npc.despawnTick ?? frame.state.currentTick) * 30,
            lifeKey: life.key,
            npc,
          };
          this.deathsByLife.set(life.key, record);
          this.deathRecords.push(record);
        }
      }
      for (const actorId of this.presentActorIds) {
        if (!presentActorIds.has(actorId)) {
          const life = this.actorLives.get(actorId);
          if (life) life.present = false;
        }
      }
      this.presentActorIds = presentActorIds;
      for (const cue of describePlayerPrimaries(frame))
        this.playerPrimaries.push({ frameIndex: this.indexedLength, tick: cue.tick, value: cue });
      for (const cue of describeYamaPrimaries(frame.state))
        this.yamaPrimaries.push({ frameIndex: this.indexedLength, tick: frame.state.currentTick, value: cue });
      for (const [ordinal, effect] of describePlayerEffects(frame).entries()) {
        const entry = { frameIndex: this.indexedLength, tick: effect.tick, ordinal, value: effect };
        switch (effect.kind) {
          case 'graphic':
            this.graphics.push(entry);
            break;
          case 'projectile':
          case 'impact': {
            const spotAnimId = effect.kind === 'projectile' ? effect.visuals.hitSpotanim : effect.spotAnimId;
            let stream = this.travel.get(spotAnimId);
            if (!stream) {
              stream = { entries: [], maximumDelayCycles: 0 };
              this.travel.set(spotAnimId, stream);
            }
            const end = effect.kind === 'projectile' ? projectileEndCycle(effect) + 1 : effect.startTick * 30;
            stream.maximumDelayCycles = Math.max(stream.maximumDelayCycles, end - effect.tick * 30);
            stream.entries.push({ ...entry, value: effect });
            break;
          }
          default: {
            const exhaustive: never = effect;
            throw exhaustive;
          }
        }
      }
      for (const [ordinal, event] of frame.events.entries()) {
        const entry = { frameIndex: this.indexedLength, tick: event.tick, ordinal, value: event };
        const yama = describeYamaAttack(event);
        if (yama) this.yamaAttacks.push({ ...entry, value: yama });
        if (event.type === 'voidflare_exploded' || event.type === 'voidflare_destroyed') this.flareEvents.push(entry);
        if (event.type === 'actor_despawned' && typeof event.actorId === 'string') {
          const life = this.actorLives.get(event.actorId);
          if (life && !this.deathSuppressions.has(life.key)) {
            this.deathSuppressions.set(life.key, { ...entry, value: undefined });
          }
        }
        if (isActorPresentationsRemovedEvent(event)) {
          for (const npcTypeId of new Set<number>(event.npcTypeIds)) {
            let removals = this.typeRemovals.get(npcTypeId);
            if (!removals) {
              removals = [];
              this.typeRemovals.set(npcTypeId, removals);
            }
            removals.push({ ...entry, value: undefined });
          }
        }
      }
    }
  }

  playerEffects(
    destination: ReplayEffectDestination,
    duration: EffectDurationResolver,
  ): readonly PlayerEffectDescriptor[] {
    const result: PlayerEffectDescriptor[] = [];
    const travel: Entry<PlayerTravelDescriptor>[] = [];
    const graphic = this.graphics[upperBound(this.graphics, destination) - 1]?.value;
    if (graphic?.kind === 'graphic') {
      const lifetime = duration(graphic.spotAnimId);
      if (lifetime === undefined || destination.cycle < graphic.tick * 30 + lifetime) result.push(graphic);
    }
    for (const [spotAnimId, stream] of this.travel) {
      const lifetime = spotAnimId < 0 ? 0 : duration(spotAnimId);
      if (lifetime === undefined) continue;
      const end = upperBound(stream.entries, destination);
      const start = upperBound(stream.entries, {
        ...destination,
        cycle: destination.cycle - stream.maximumDelayCycles - lifetime,
      });
      for (let index = start; index < end; index++) {
        const entry = stream.entries[index];
        if (!entry) continue;
        const effect = entry.value;
        const expiry =
          effect.kind === 'projectile'
            ? Math.max(projectileEndCycle(effect) + 1, projectileEndCycle(effect) + lifetime)
            : effect.startTick * 30 + lifetime;
        if (destination.cycle < expiry) travel.push(entry);
      }
    }
    travel.sort((left, right) => left.frameIndex - right.frameIndex || left.ordinal - right.ordinal);
    return [...result, ...travel.map((entry) => entry.value)];
  }

  latestYamaAttack(destination: ReplayEffectDestination): YamaAttackDescriptor | undefined {
    return this.yamaAttacks[upperBound(this.yamaAttacks, destination) - 1]?.value;
  }

  recentFlareEvents(destination: ReplayEffectDestination): readonly GameEvent[] {
    const end = upperBound(this.flareEvents, destination);
    const start = upperBound(
      this.flareEvents,
      { ...destination, cycle: destination.cycle - VOID_FLARE_EXPLOSION_DURATION_TICKS * 30 },
      false,
    );
    return this.flareEvents.slice(start, end).map((entry) => entry.value);
  }

  deathPresentations(
    destination: ReplayEffectDestination,
    maximumDeathDurationMs: number,
  ): readonly ReplayDeathPresentation[] {
    const earliestCycle = destination.cycle - maximumDeathDurationMs / CLIENT_TICK_MS;
    const result: ReplayDeathPresentation[] = [];
    for (let index = this.deathRecords.length - 1; index >= 0; index--) {
      const record = this.deathRecords[index];
      if (!record) continue;
      if (record.deathCycle < earliestCycle) continue;
      if (record.frameIndex > destination.throughFrameIndex || record.deathCycle > destination.cycle) continue;
      const elapsedMs = (destination.cycle - record.deathCycle) * CLIENT_TICK_MS;
      if (elapsedMs >= maximumDeathDurationMs) continue;
      const clears = this.typeRemovals.get(record.npc.npcTypeId) ?? [];
      let lower = 0;
      let upper = clears.length;
      while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2);
        if (clears[middle].frameIndex < record.frameIndex) lower = middle + 1;
        else upper = middle;
      }
      const typeSuppression = clears[lower];
      const actorSuppression = this.deathSuppressions.get(record.lifeKey);
      const suppression =
        !actorSuppression ||
        (typeSuppression &&
          (typeSuppression.frameIndex < actorSuppression.frameIndex ||
            (typeSuppression.frameIndex === actorSuppression.frameIndex &&
              typeSuppression.ordinal < actorSuppression.ordinal)))
          ? typeSuppression
          : actorSuppression;
      if (
        suppression &&
        suppression.frameIndex <= destination.throughFrameIndex &&
        suppression.tick * 30 <= destination.cycle
      )
        continue;
      result.push({ npc: record.npc, elapsedMs });
    }
    result.reverse();
    return result;
  }
}
