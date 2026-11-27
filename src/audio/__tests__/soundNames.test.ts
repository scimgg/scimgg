import { describe, expect, it } from 'vitest';
import { encounterAudioRules } from '../../encounters/presentationModules';
import { coreAudioRules } from '../coreAudioRules';
import { EventAudioPlayer } from '../EventAudioPlayer';
import { FRAME_SOUND_IDS } from '../frameSoundManifest';
import { ALL_SOUND_IDS, SOUND_NAMES } from '../soundNames';

describe('ALL_SOUND_IDS', () => {
  // The rules and the animation frame sounds are the only callers of AudioEngine.play; a rule that
  // resolves an id at event time must name it in `preloadIds`, or it is missing here and in the trim.
  it('lists exactly the ids the audio rules and animation frame sounds can play', () => {
    // Every encounter's rules, whichever encounter is displayed: the inventory is what can ever play.
    const player = new EventAudioPlayer(null as never, ...encounterAudioRules(), coreAudioRules);
    const used = [...new Set([...player.getAllSoundIds(), ...FRAME_SOUND_IDS])].sort((a, b) => a - b);

    expect(used.filter((id) => !ALL_SOUND_IDS.includes(id))).toEqual([]);
    expect(ALL_SOUND_IDS.filter((id) => !used.includes(id))).toEqual([]);
  });

  it('names no sound the app cannot play', () => {
    expect(
      Object.keys(SOUND_NAMES)
        .map(Number)
        .filter((id) => !ALL_SOUND_IDS.includes(id)),
    ).toEqual([]);
  });

  it('is sorted ascending with no duplicates', () => {
    expect([...ALL_SOUND_IDS]).toEqual([...new Set(ALL_SOUND_IDS)].sort((a, b) => a - b));
  });
});
