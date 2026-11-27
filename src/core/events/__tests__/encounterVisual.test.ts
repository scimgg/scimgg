import { describe, expect, it } from 'vitest';
import {
  actorPresentationsRemoved,
  type EncounterVisualBatch,
  emitEncounterVisual,
  encounterVisual,
  isActorPresentationsRemovedEvent,
  isEncounterVisualEvent,
} from '../encounterVisual';
import { TickEvents } from '../TickEvents';

const cue: EncounterVisualBatch = {
  animations: [{ actorId: 'zuk', clipId: 'attack', delayCycles: 0 }],
  projectiles: [],
  graphics: [
    {
      spotAnimId: 444,
      target: { kind: 'actor', actorId: 'nib', size: 1, position: [18, 18] },
      delayCycles: 30,
      height: 150,
    },
    { spotAnimId: 451, target: { kind: 'attached', actorId: 'sol' }, delayCycles: 9, height: 0 },
  ],
};

describe('the encounter visual batch', () => {
  it('clones the cue when emitted through TickEvents', () => {
    const events = new TickEvents();
    events.setTick(13);
    emitEncounterVisual(events, cue);
    const event = events.flush()[0];
    expect(isEncounterVisualEvent(event)).toBe(true);
    if (!isEncounterVisualEvent(event)) throw new TypeError('Missing visual event');
    expect(event).toMatchObject({ type: 'encounter_visual', tick: 13, eventId: 1, ...cue });
    expect(event.animations).not.toBe(cue.animations);
  });

  it('builds the same batch unstamped, for an emitter that returns its events', () => {
    const event = encounterVisual(cue);

    expect(event).toEqual({ type: 'encounter_visual', ...cue });
    expect(event.graphics).not.toBe(cue.graphics);
    expect(isEncounterVisualEvent({ ...event, eventId: 4, tick: 2 })).toBe(true);
  });

  it('rejects malformed recorded cues instead of assigning missing heights', () => {
    const event = {
      type: 'encounter_visual',
      eventId: 1,
      tick: 0,
      animations: [],
      projectiles: [],
      graphics: [{ spotAnimId: 451, target: { kind: 'tile', position: [31, 44] }, delayCycles: 0 }],
    };
    expect(isEncounterVisualEvent(event)).toBe(false);
    expect(isEncounterVisualEvent({ ...event, graphics: [], animations: [null] })).toBe(false);
    // An attachment has no recorded fallback to draw on, so it carries no position or size.
    expect(isEncounterVisualEvent({ ...event, graphics: [{ ...cue.graphics[1], target: { kind: 'attached' } }] })).toBe(
      false,
    );
  });

  it('names the NPC types whose presentations are removed, and nothing else', () => {
    const event = { ...actorPresentationsRemoved([7703, 7702]), eventId: 3, tick: 1 };

    expect(event).toEqual({ type: 'actor_presentations_removed', npcTypeIds: [7703, 7702], eventId: 3, tick: 1 });
    expect(isActorPresentationsRemovedEvent(event)).toBe(true);
    expect(isActorPresentationsRemovedEvent({ ...event, npcTypeIds: [7703, '7702'] })).toBe(false);
    expect(isActorPresentationsRemovedEvent({ ...event, npcTypeIds: undefined })).toBe(false);
  });
});
