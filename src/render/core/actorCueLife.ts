import type { NpcSnapshot } from '../../types/simulation';
import type { ReplayEffectDestination } from './replayEffectIndex';

/** Where a life changed: the frame that showed it and the tick of its state or event. */
type LifeStamp = { readonly frameIndex: number; readonly tick: number };

/** Whether `stamp` has happened by `destination`; live play (no destination) has seen everything it holds. */
const happenedBy = (stamp: LifeStamp, destination: ReplayEffectDestination | undefined): boolean =>
  !destination || (stamp.frameIndex <= destination.throughFrameIndex && stamp.tick * 30 <= destination.cycle);

/**
 * The presentation life of an actor that a cue riding it (a clip, or a graphic `attached` to it) was
 * emitted for. A cue plays only while its life lasts: once the simulation removes the actor
 * (`actor_despawned`) or the actor's id shows on a new spawn, the cue is gone, and the new life never
 * plays it, whatever clip keys its type declares.
 */
export class ActorCueLife {
  private bound: { readonly spawnTick: number | undefined; readonly at: LifeStamp } | undefined;
  private ended: LifeStamp | undefined;

  /** The spawn tick this life is the actor's life of, once the actor has shown by `destination`. */
  spawnTickBy(destination?: ReplayEffectDestination): { readonly spawnTick: number | undefined } | undefined {
    return this.bound && happenedBy(this.bound.at, destination) ? this.bound : undefined;
  }

  isEndedBy(destination?: ReplayEffectDestination): boolean {
    return this.ended !== undefined && happenedBy(this.ended, destination);
  }

  bind(spawnTick: number | undefined, at: LifeStamp): void {
    this.bound ??= { spawnTick, at };
  }

  end(at: LifeStamp): void {
    this.ended ??= at;
  }
}

/**
 * Works out, as frames arrive, which life of its actor each actor-bound cue belongs to; one rule for
 * live play and for a replay history's index. A cue emitted while its actor is present belongs to
 * that life; one emitted for an actor not yet present belongs to the actor's next life (an encounter
 * may schedule a clip for an actor it is about to add). Removals end lives in event order, so a
 * removal ends the cues emitted before it but not a replacement's later batch.
 */
export class ActorCueLives {
  /** Each actor's lives that have not ended: its current one, and any it has yet to show. */
  private readonly lives = new Map<string, ActorCueLife[]>();
  private present = new Map<string, NpcSnapshot>();
  private at: LifeStamp = { frameIndex: -1, tick: -1 };

  /**
   * Takes a frame's actors, before its events: a life not yet shown binds to its actor's spawn, and a
   * life whose actor now shows another spawn ends.
   */
  observe(npcs: readonly NpcSnapshot[], at: LifeStamp): void {
    this.present = new Map(npcs.map((npc) => [npc.id, npc]));
    this.at = at;
    for (const npc of npcs) this.observeActor(npc, at);
  }

  /** The life a cue emitted on `actorId` in the observed frame belongs to. */
  lifeOf(actorId: string): ActorCueLife {
    const npc = this.present.get(actorId);
    const lives = this.lives.get(actorId) ?? [];
    this.lives.set(actorId, lives);
    const life = lives.find((candidate) =>
      npc === undefined ? candidate.spawnTickBy() === undefined : candidate.spawnTickBy()?.spawnTick === npc.spawnTick,
    );
    if (life) return life;
    const created = new ActorCueLife();
    if (npc) created.bind(npc.spawnTick, this.at);
    lives.push(created);
    return created;
  }

  /** The simulation removed `actorId` outright: every life of it held so far ends. */
  remove(actorId: string, at: LifeStamp): void {
    for (const life of this.lives.get(actorId) ?? []) life.end(at);
    this.lives.delete(actorId);
  }

  /**
   * Re-creates, as it stood at `destination`, a life another tracker (a replay history's index) holds,
   * so live play can carry on with the cues a restored presentation hands it. `adopted` keeps cues of
   * one life on one copy.
   */
  adopt(
    actorId: string,
    life: ActorCueLife,
    destination: ReplayEffectDestination,
    adopted: Map<ActorCueLife, ActorCueLife>,
  ): ActorCueLife | undefined {
    if (life.isEndedBy(destination)) return undefined;
    const existing = adopted.get(life);
    if (existing) return existing;
    const copy = new ActorCueLife();
    const bound = life.spawnTickBy(destination);
    if (bound) copy.bind(bound.spawnTick, { frameIndex: -1, tick: -1 });
    const lives = this.lives.get(actorId) ?? [];
    lives.push(copy);
    this.lives.set(actorId, lives);
    adopted.set(life, copy);
    return copy;
  }

  clear(): void {
    this.lives.clear();
    this.present = new Map();
  }

  private observeActor(npc: NpcSnapshot, at: LifeStamp): void {
    const lives = this.lives.get(npc.id);
    if (!lives) return;
    for (const life of lives) {
      const bound = life.spawnTickBy();
      if (!bound) life.bind(npc.spawnTick, at);
      else if (bound.spawnTick !== npc.spawnTick) life.end(at);
    }
    const open = lives.filter((life) => !life.isEndedBy());
    if (open.length > 0) this.lives.set(npc.id, open);
    else this.lives.delete(npc.id);
  }
}
