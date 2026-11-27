import { isActorPresentationsRemovedEvent } from '../../core/events/encounterVisual';
import type { ReplayDisplayFrame } from '../../core/ReplayRecorder';
import type { NpcSnapshot } from '../../types/simulation';
import {
  describePlayerEffects,
  type PlayerEffectDescriptor,
  type PlayerTravelDescriptor,
  projectileEndCycle,
} from '../effects/playerEffectDescriptors';
import { CLIENT_TICK_MS } from '../npc/animationTypes';
import { EncounterCueIndex } from './encounterCueIndex';
import { ReplayActorHistory } from './replayActorHistory';
import { describePlayerPrimaries, type PlayerPrimaryClip, type PlayerPrimaryCue } from './replayPrimaryCues';
import { type PrimaryCue, ReplayPrimaryIndex } from './replayPrimaryIndex';

export type ReplayEffectDestination = { readonly cycle: number; readonly throughFrameIndex: number };
/** An encounter's own reading of a history, fed each frame once, in order, by the index's append pass. */
export interface ReplayFrameReader {
  append(frame: ReplayDisplayFrame, frameIndex: number): void;
}
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
  readonly playerPrimaryTimeline = new ReplayPrimaryIndex<PlayerPrimaryCue, PlayerPrimaryClip>(this.playerPrimaries);
  private indexedLength = 0;
  private readonly graphics: Entry<PlayerEffectDescriptor>[] = [];
  private readonly travel = new Map<number, TravelStream>();
  private readonly actorLives = new Map<string, ActorLife>();
  private presentActorIds = new Set<string>();
  private readonly deathsByLife = new Map<number, DeathPresentationRecord>();
  private readonly deathRecords: DeathPresentationRecord[] = [];
  private readonly deathSuppressions = new Map<number, Entry<undefined>>();
  /** Each NPC type's `actor_presentations_removed` events, in frame order. */
  private readonly typeRemovals = new Map<number, Entry<undefined>[]>();
  private nextLifeKey = 0;

  /** @param encounter The scene's encounter-specific reading of the same frames, if it has one. */
  constructor(
    readonly frames: readonly ReplayDisplayFrame[],
    readonly encounter?: ReplayFrameReader,
  ) {
    this.extend();
  }

  extend(): void {
    for (; this.indexedLength < this.frames.length; this.indexedLength++) {
      const source = this.frames[this.indexedLength];
      // Each frame's events are read once, however many indexes consume them.
      const frame = { state: source.state, events: source.events };
      this.cues.append(frame.events, this.indexedLength);
      this.actors.append(frame, this.indexedLength);
      this.encounter?.append(source, this.indexedLength);
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
