import { z } from 'zod';
import {
  ACTOR_PRESENTATIONS_REMOVED_EVENT,
  ENCOUNTER_VISUAL_EVENT,
  npcProjectileCueSchema,
  npcVisualTargetSchema,
} from './events/encounterVisual';
import type { GameEvent } from './events/types';

/**
 * Reads recordings made before the encounter visual batch existed. Their encounter-specific wire
 * shapes become today's events as a recording is loaded, before any consumer sees a frame, so playback,
 * seeking, audio and the effect index only ever know the current shapes. Each converted event keeps its
 * id, tick, frame, position in the frame, cue order and every per-occurrence parameter; any other event
 * passes through untouched. The input is never modified.
 *
 * - `inferno_visual` (49ef532 and before) is an `encounter_visual` batch: the same clips, projectiles
 *   and graphics, whose `actor` and `tile` targets mean what they mean in the batch.
 * - `inferno_clear_minions` is an `actor_presentations_removed` of the same NPC types.
 */

const cycles = z.number().int().nonnegative();

const legacyInfernoVisualSchema = z.object({
  type: z.literal('inferno_visual'),
  eventId: cycles,
  tick: cycles,
  animations: z.array(z.object({ actorId: z.string().min(1), clipId: z.string().min(1), delayCycles: cycles })),
  projectiles: z.array(npcProjectileCueSchema),
  graphics: z.array(
    z.object({ spotAnimId: cycles, target: npcVisualTargetSchema, delayCycles: cycles, height: cycles }),
  ),
});

const legacyClearMinionsSchema = z.object({
  type: z.literal('inferno_clear_minions'),
  eventId: cycles,
  tick: cycles,
  npcTypeIds: z.array(z.number().int()),
});

/** A recognized old event whose payload is not one its encounter could have written. */
export class LegacyReplayEventError extends Error {
  constructor(
    readonly frameIndex: number,
    readonly event: GameEvent,
    detail: string,
  ) {
    super(
      `Replay frame ${frameIndex} holds a malformed '${event.type}' event (eventId ${String(event.eventId)}): ${detail}`,
    );
    this.name = 'LegacyReplayEventError';
  }
}

function decodeEvent(event: GameEvent, frameIndex: number): GameEvent {
  switch (event.type) {
    case 'inferno_visual': {
      const parsed = legacyInfernoVisualSchema.safeParse(event);
      if (!parsed.success) throw new LegacyReplayEventError(frameIndex, event, parsed.error.message);
      return { ...event, type: ENCOUNTER_VISUAL_EVENT };
    }
    case 'inferno_clear_minions': {
      const parsed = legacyClearMinionsSchema.safeParse(event);
      if (!parsed.success) throw new LegacyReplayEventError(frameIndex, event, parsed.error.message);
      return { ...event, type: ACTOR_PRESENTATIONS_REMOVED_EVENT };
    }
    default:
      return event;
  }
}

/**
 * Each frame's events in today's shapes, in the frames' order. A frame with nothing to convert is
 * returned as it is; one with a malformed recognized payload throws `LegacyReplayEventError` before
 * the caller installs anything.
 */
export function decodeLegacyReplayFrames<Frame extends { readonly events: readonly GameEvent[] }>(
  frames: readonly Frame[],
): Frame[] {
  return frames.map((frame, frameIndex) => {
    let events: GameEvent[] | undefined;
    for (let index = 0; index < frame.events.length; index++) {
      const event = frame.events[index];
      const decoded = decodeEvent(event, frameIndex);
      if (decoded === event && events === undefined) continue;
      events ??= frame.events.slice(0, index);
      events.push(decoded);
    }
    return events === undefined ? frame : { ...frame, events };
  });
}
