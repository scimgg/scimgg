import { afterEach, describe, expect, it, vi } from 'vitest';
import { setArenaConfig, setDefaultArenaConfig } from '../../core/constants';
import type { ReplayDisplayFrame } from '../../core/ReplayRecorder';
import { encounterAudioLayers } from '../../encounters/presentationModules';
import {
  LEGACY_INFERNO_EVENTS,
  legacyInfernoRecording,
  legacySolRecording,
  legacyYamaRecording,
} from '../../test/helpers/legacyEncounterRecordings';
import { AudioEngine } from '../AudioEngine';
import { coreAudioRules } from '../coreAudioRules';
import { EventAudioPlayer } from '../EventAudioPlayer';

/**
 * What the app's event-audio dispatcher plays for recordings in the 49ef532 encounter event shapes
 * (`legacyEncounterRecordings`), event by event, as a live frame delivers them.
 *
 * Every expectation here is meant to survive the encounter-cue migration unchanged. Only
 * `dispatcherFor` may change: today the app installs every encounter's layer whatever is displayed
 * (`useAudioManager`), so it ignores `kind`; scoping audio to the displayed encounter replaces it.
 * Triggers are not compared: they name the event type, which a converted recording may rename.
 */
function dispatcherFor(_kind: string) {
  const engine = new AudioEngine();
  const played = vi.spyOn(engine, 'play').mockImplementation(() => undefined);
  const player = new EventAudioPlayer(engine, ...encounterAudioLayers(), { name: 'core', rules: coreAudioRules });
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

describe('event audio routing on 49ef532 (expected to change when audio is scoped)', () => {
  // Every encounter's layer is installed whatever is displayed, so an Inferno batch sounds even in an
  // encounter with no rules of its own. Scoping audio to the displayed encounter silences this.
  it('plays an Inferno spark landing while the lobby is displayed', () => {
    const { player, played } = dispatcherFor('lobby');
    player.onEvents([LEGACY_INFERNO_EVENTS.barrage], [25, 25]);
    expect(played.mock.calls.map(([id]) => id)).toEqual([156]);
  });
});
