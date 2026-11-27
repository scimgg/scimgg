import { z } from 'zod';
import type { Coordinate } from '../../types/simulation';
import type { TickEvents } from './TickEvents';
import type { GameEvent } from './types';

/**
 * The encounter visual batch: explicitly scheduled clips, NPC projectiles and one-shot graphics an
 * encounter emits at one visual transition, for the scene's shared cue player.
 *
 * Semantic events stay the normal mechanics API (docs/architecture/events.md). This batch is the narrow
 * exception for transitions that ARE a set of visual instructions: per-occurrence delays, landing
 * tiles and heights a semantic event would only restate. Never emit a batch and also map a semantic
 * event to the same effect.
 *
 * Delays count client cycles (30 per tick) from the emitting tick. Each cue's identity is the batch's
 * event id, its family and its ordinal, so batch boundaries and order are part of the wire contract.
 */

/** Where an NPC projectile lands, or what a tracked graphic is drawn on. */
export type NpcVisualTarget =
  /** Follows the actor's rendered position; `position` is where it aims if the actor never renders. */
  | { readonly kind: 'actor'; readonly actorId: string; readonly size: number; readonly position: Coordinate }
  | { readonly kind: 'tile'; readonly position: Coordinate };

/**
 * One NPC projectile as its projectile record describes it. Visual only: the hit it carries is
 * resolved separately by the attack request. Packet `angle` is `slope` and `progress` is
 * `startOffset`; heights are raw OSRS units. See
 * docs/architecture/projectile-motion.md#inputs-and-lifetime-boundary for the arrival convention.
 */
export type NpcProjectileCue = {
  readonly spotAnimId: number;
  /** World-space launch point: the attacker's center tile center, not its south-west tile. */
  readonly sourcePosition: Coordinate;
  readonly target: NpcVisualTarget;
  /** Client cycles after the emitting tick, 30 per tick: packet `starttime`. */
  readonly startDelayCycles: number;
  /** Packet `endtime`: arrival, and the exclusive end of the flight. */
  readonly endDelayCycles: number;
  readonly slope: number;
  readonly startOffset: number;
  readonly startHeight: number;
  readonly endHeight: number;
};

/**
 * What a one-shot graphic is drawn on. A tile graphic stands on the tile's center; an `actor` graphic
 * on the actor's rendered center, or its recorded `position` while the actor is not rendered; an
 * `attached` graphic rides the actor's rendered model, turning with it, and is hidden while the actor
 * is absent.
 */
export type EncounterGraphicTarget = NpcVisualTarget | { readonly kind: 'attached'; readonly actorId: string };

export type EncounterClipCue = {
  readonly actorId: string;
  /** Key into the render config's `attackClips`, not a raw sequence id. */
  readonly clipId: string;
  readonly delayCycles: number;
};

export type EncounterGraphicCue = {
  readonly spotAnimId: number;
  readonly target: EncounterGraphicTarget;
  readonly delayCycles: number;
  /** Raw OSRS height above the anchor, per occurrence. */
  readonly height: number;
};

export type EncounterVisualCue = {
  readonly animations: readonly EncounterClipCue[];
  readonly projectiles: readonly NpcProjectileCue[];
  readonly graphics: readonly EncounterGraphicCue[];
};

export const ENCOUNTER_VISUAL_EVENT = 'encounter_visual';
export type EncounterVisualEvent = GameEvent & EncounterVisualCue & { readonly type: typeof ENCOUNTER_VISUAL_EVENT };
export type UnstampedEncounterVisualEvent = EncounterVisualCue & { readonly type: typeof ENCOUNTER_VISUAL_EVENT };

const cycles = z.number().int().nonnegative();
const coordinate = z.tuple([z.number(), z.number()]);

export const npcVisualTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('actor'),
    actorId: z.string().min(1),
    size: z.number().int().positive(),
    position: coordinate,
  }),
  z.object({ kind: z.literal('tile'), position: coordinate }),
]);

export const npcProjectileCueSchema = z
  .object({
    spotAnimId: cycles,
    sourcePosition: coordinate,
    target: npcVisualTargetSchema,
    startDelayCycles: cycles,
    endDelayCycles: cycles,
    slope: cycles,
    startOffset: cycles,
    startHeight: cycles,
    endHeight: cycles,
  })
  .refine((cue) => cue.endDelayCycles >= cue.startDelayCycles);

const graphicTargetSchema = z.union([
  npcVisualTargetSchema,
  z.object({ kind: z.literal('attached'), actorId: z.string().min(1) }),
]);

export const encounterVisualCueSchema = z.object({
  animations: z.array(z.object({ actorId: z.string().min(1), clipId: z.string().min(1), delayCycles: cycles })),
  projectiles: z.array(npcProjectileCueSchema),
  graphics: z.array(z.object({ spotAnimId: cycles, target: graphicTargetSchema, delayCycles: cycles, height: cycles })),
});

const encounterVisualEventSchema = encounterVisualCueSchema.extend({
  type: z.literal(ENCOUNTER_VISUAL_EVENT),
  eventId: cycles,
  tick: cycles,
});

export function isEncounterVisualEvent(event: GameEvent): event is EncounterVisualEvent {
  return event.type === ENCOUNTER_VISUAL_EVENT && encounterVisualEventSchema.safeParse(event).success;
}

/**
 * The batch as an unstamped event, for an emitter that returns its events rather than emitting them
 * (`TickEvents.emit` stamps the tick and id). The cue is copied, so the caller may reuse it.
 */
export function encounterVisual(cue: EncounterVisualCue): UnstampedEncounterVisualEvent {
  return { type: ENCOUNTER_VISUAL_EVENT, ...structuredClone(cue) };
}

export function emitEncounterVisual(events: TickEvents, cue: EncounterVisualCue): void {
  events.emit(encounterVisual(cue));
}

/**
 * Removes the drawn presentation of every actor of these NPC types, corpses included, before this
 * frame's actors are synced: a practice command clearing a set and spawning another in its place.
 * Plain `actor_despawned` is not equivalent: a corpse the simulation already pruned is no actor any
 * more, but may still be displayed.
 */
export const ACTOR_PRESENTATIONS_REMOVED_EVENT = 'actor_presentations_removed';
export type ActorPresentationsRemovedEvent = GameEvent & {
  readonly type: typeof ACTOR_PRESENTATIONS_REMOVED_EVENT;
  readonly npcTypeIds: readonly number[];
};

export function actorPresentationsRemoved(npcTypeIds: readonly number[]): {
  readonly type: typeof ACTOR_PRESENTATIONS_REMOVED_EVENT;
  readonly npcTypeIds: readonly number[];
} {
  return { type: ACTOR_PRESENTATIONS_REMOVED_EVENT, npcTypeIds: [...npcTypeIds] };
}

export function isActorPresentationsRemovedEvent(event: GameEvent): event is ActorPresentationsRemovedEvent {
  return (
    event.type === ACTOR_PRESENTATIONS_REMOVED_EVENT &&
    Array.isArray(event.npcTypeIds) &&
    event.npcTypeIds.every((npcTypeId: unknown) => typeof npcTypeId === 'number' && Number.isInteger(npcTypeId))
  );
}
