import { afterEach, describe, expect, it, vi } from 'vitest';
import { setArenaConfig, setDefaultArenaConfig } from '../../core/constants';
import type { GameEvent } from '../../core/events/types';
import { decodeLegacyReplayFrames } from '../../core/legacyReplayEvents';
import type { ReplayDisplayFrame } from '../../core/ReplayRecorder';
import { createEventAudioPlayer, eventAudioRulesFor } from '../../hooks/useAudioManager';
import {
  LEGACY_INFERNO_EVENTS,
  LEGACY_SOL_EVENTS,
  legacyInfernoRecording,
  legacySolRecording,
  legacyYamaRecording,
} from '../../test/helpers/legacyEncounterRecordings';
import type { Coordinate } from '../../types/simulation';
import { AudioEngine } from '../AudioEngine';

/**
 * What the app's event-audio dispatcher plays for recordings in the old encounter event shapes
 * (`legacyEncounterRecordings`), event by event, as a live frame delivers them.
 *
 * The first block pins the sounds a player hears, whatever shape the recording uses.
 * `dispatcherFor` builds the player as `useAudioManager` does and scopes it as `useEventAudioScope`
 * does for the displayed `kind`. Triggers are not compared: they name the event type, which a converted
 * recording may rename.
 */
function dispatcherFor(kind: string) {
  const engine = new AudioEngine();
  const played = vi.spyOn(engine, 'play').mockImplementation(() => undefined);
  const player = createEventAudioPlayer(engine);
  player.setDispatchRules(eventAudioRulesFor(kind));
  return { player, played };
}

/** Each frame's sounds in delivery order: [tick, id, options], volume to four places. */
function sounds(kind: string, frames: readonly ReplayDisplayFrame[]) {
  const { player, played } = dispatcherFor(kind);
  return frames.flatMap(({ state, events }) => {
    played.mockClear();
    player.onEvents([...events], state.playerPosition);
    return played.mock.calls.map(([id, options]) => [
      state.currentTick,
      id,
      { ...options, ...(options?.volume === undefined ? {} : { volume: Math.round(options.volume * 1e4) / 1e4 }) },
    ]);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

describe('event audio for legacy encounter recordings', () => {
  it('plays an Inferno tile spark landing once, at its tile and on its own delay, and nothing for clips', () => {
    // The player stands on [26, 26], one tile from the landing on [25, 25] (range 8).
    expect(sounds('inferno', legacyInfernoRecording().frames)).toEqual([
      [2, 156, { volume: 0.875, channel: 'area', delayMs: 60 }],
    ]);
  });

  it('plays one sound pair per Sol sand burst and one area sound per beam impact, without its graphic delay', () => {
    // The impacts' graphics wait 9 cycles; their sounds do not. The player stands on [20, 20].
    expect(sounds('sol_heredit', legacySolRecording().frames)).toEqual([
      [1, 8053, { volume: 1, channel: 'sfx', delayMs: 600 }],
      [1, 10046, { volume: 1, channel: 'sfx', delayMs: 1800 }],
      // Range 20 at each impact tile, [24, 23] and [25, 23]: Manhattan distance 7 and 8, less one.
      [3, 8230, { volume: 0.7, channel: 'area' }],
      [3, 8230, { volume: 0.65, channel: 'area' }],
    ]);
  });

  it("plays a Yama contract's fireball barrage and wave ambience from Yama's layer", () => {
    expect(sounds('yama_p3_divine', legacyYamaRecording().frames)).toEqual([
      [10, 9335, { volume: 1, channel: 'sfx', delayMs: 60 }],
      [10, 10255, { volume: 1, channel: 'sfx', delayMs: 2000 }],
      [10, 10268, { volume: 1, channel: 'sfx', delayMs: 2100 }],
      [11, 10238, { volume: 1, channel: 'sfx' }],
    ]);
  });
});

describe('event audio routing to the displayed encounter', () => {
  // As a loaded recording delivers them: in today's shapes.
  const idsPlayed = (kind: string, events: readonly GameEvent[], position: Coordinate) => {
    const { player, played } = dispatcherFor(kind);
    player.onEvents([...decodeLegacyReplayFrames([{ events }])[0].events], position);
    return played.mock.calls.map(([id]) => id);
  };

  it("plays an Inferno spark landing only while the Inferno's scene is displayed", () => {
    expect(idsPlayed('inferno', [LEGACY_INFERNO_EVENTS.barrage], [25, 25])).toEqual([156]);
    // Only the displayed encounter's rules answer: an Inferno event shown in another scene is silent.
    expect(idsPlayed('lobby', [LEGACY_INFERNO_EVENTS.barrage], [25, 25])).toEqual([]);
    expect(idsPlayed('sol_heredit', [LEGACY_INFERNO_EVENTS.barrage], [25, 25])).toEqual([]);
  });

  it("plays Sol's sand burst only while Sol's scene is displayed", () => {
    expect(idsPlayed('sol_heredit', [LEGACY_SOL_EVENTS.telegraph], [20, 20])).toEqual([8053, 10046]);
    expect(idsPlayed('inferno', [LEGACY_SOL_EVENTS.telegraph], [20, 20])).toEqual([]);
    expect(idsPlayed('yama_p3', [LEGACY_SOL_EVENTS.telegraph], [20, 20])).toEqual([]);
  });

  it('keeps core sounds in every encounter, the lobby and an unregistered kind included', () => {
    const death: GameEvent = { type: 'actor_died', eventId: 1, tick: 10, actorId: 'player' };
    const core = idsPlayed('lobby', [death], [20, 20]);
    expect(core.length).toBeGreaterThan(0);
    for (const kind of ['inferno', 'sol_heredit', 'yama_p3_divine', 'no_such_encounter'])
      expect(idsPlayed(kind, [death], [20, 20]), kind).toEqual(core);
  });
});
