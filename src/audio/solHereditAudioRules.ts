import { isEncounterVisualEvent } from '../core/events/encounterVisual';
import { SOL_BEAM_PREPARED_EVENT } from '../encounters/solHeredit/constants';
import { COLOSSEUM_SPOTANIMS } from '../npcs/colosseum/constants';
import { play, type SoundRule, silent, type TimedSound } from './EventAudioPlayer';

/**
 * Sol Heredit's sounds, limited to the ones a capture actually attributes to him.
 *
 * Attribution matters here: the loudest id in both captures (`synth_sound 2524`, 81 plays) fires on
 * all 81 `scythe_of_vitur_attack` ticks and is the PLAYER's weapon, not Sol. Only ids that track a
 * Sol or crystal event are wired below; the rest stay out rather than being guessed at.
 *
 * Sol's own attack sounds are NOT here on purpose. They live in his animation frames, so
 * `FrameSoundTracker` plays them from the cache once the telegraph clip runs — see
 * `frameSoundManifest.ts`.
 */

/**
 * Lightning emission: K:4023 / M:8293 carry 8053 at +30 cycles and 10046 at +90.
 * The later 8253/8213 pair belongs to the beam warning, not the sand strike.
 */
const MOLTEN_SAND: TimedSound[] = [
  { id: 8053, delayCycles: 30, channel: 'sfx' },
  { id: 10046, delayCycles: 90, channel: 'sfx' },
];

/**
 * K:4077: `sound_area 8230` is at each terminal impact tile, not at the crystal.
 * It has no delay, unlike the impact map_anim's delay=39. Keep the two clocks separate.
 */
const BEAM_FIRE_ID = 8230;
const BEAM_FIRE_RANGE = 20;

/**
 * Beam warning, sent three ticks before each charge: 8253 at +75 cycles, and 8213 timed to land on
 * the fire tick (210 normally, 180 for an enraged three-tick charge; K:4029..4218, M:8299..8508).
 */
const BEAM_WARNING_ID = 8253;
const BEAM_WARNING_DELAY_CYCLES = 75;
const BEAM_WARNING_FIRE_ID = 8213;
const CYCLES_PER_TICK = 30;

export const solHereditAudioRules: Record<string, SoundRule> = {
  [SOL_BEAM_PREPARED_EVENT]: {
    resolve: (event) => {
      if (event.type !== SOL_BEAM_PREPARED_EVENT) return silent;
      const { fireInTicks } = event;
      return typeof fireInTicks === 'number' && Number.isInteger(fireInTicks) && fireInTicks > 0
        ? play([
            { id: BEAM_WARNING_ID, delayCycles: BEAM_WARNING_DELAY_CYCLES, channel: 'sfx' },
            { id: BEAM_WARNING_FIRE_ID, delayCycles: fireInTicks * CYCLES_PER_TICK, channel: 'sfx' },
          ])
        : silent;
    },
    preloadIds: [BEAM_WARNING_ID, BEAM_WARNING_FIRE_ID],
  },
  encounter_visual: {
    resolve: (event) => {
      if (!isEncounterVisualEvent(event)) return silent;
      const sounds: TimedSound[] = [];

      // One sand burst plays one pair of sounds, however many tiles it lit.
      if (event.graphics.some((cue) => cue.spotAnimId === COLOSSEUM_SPOTANIMS.sunfireLightning)) {
        sounds.push(...MOLTEN_SAND);
      }

      const impacts = event.graphics.filter((cue) => cue.spotAnimId === COLOSSEUM_SPOTANIMS.crystalImpact);
      // Each beam publishes one terminal impact. Intersecting beams remain distinct sounds.
      for (const cue of impacts) {
        if (cue.target.kind !== 'tile') continue;
        sounds.push({
          id: BEAM_FIRE_ID,
          position: [...cue.target.position],
          range: BEAM_FIRE_RANGE,
          channel: 'area',
        });
      }
      return sounds.length > 0 ? play(sounds) : silent;
    },
    preloadIds: [...MOLTEN_SAND.map((sound) => sound.id), BEAM_FIRE_ID],
  },
};
