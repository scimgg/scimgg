import { isEncounterVisualEvent } from '../core/events/encounterVisual';
import { COLOSSEUM_MODIFIER_CONFIRMED_EVENT } from '../encounters/colosseum/waves/waveTable';
import { SOL_BEAM_PREPARED_EVENT } from '../encounters/solHeredit/constants';
import { COLOSSEUM_SPOTANIMS } from '../npcs/colosseum/constants';
import { play, type SoundRule, silent, type TimedSound } from './EventAudioPlayer';

/**
 * The Fortis Colosseum's server-sent sounds, limited to the ones a capture actually attributes to Sol
 * or a wave enemy.
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

/*
 * Waves 1-11. Each id below is sent by the server, not a frame sound of the attack's sequences
 * (cache 2772: javelin 10892/10893, shockwave 10903, whose own frame sounds FrameSoundTracker plays),
 * so a rule is its only path. Counts are over the wave captures A/B/C
 * (docs/encounters/fortis-colosseum-facts-spec.md).
 */
/**
 * `synth_sound` with `delay` = the javelin's `endtime` (90), on its throw tick (C:1562): 261 of 370
 * throws. Nothing in the captures tells the silent ones apart; policy: every throw.
 */
const JAVELIN_THROW_ID = 8348;
/**
 * `synth_sound`, no delay, on the artillery's T+3 beside its shadow map_anim (C:1560, 73/73). The
 * shadow cue carries that map_anim's own `delay=30` on top of the tick it is emitted from.
 */
const ARTILLERY_WARNING_ID = 8356;
const ARTILLERY_SHADOW_MAP_ANIM_DELAY_CYCLES = 30;
/** `sound_area range=15`, no delay, on the blast tile with the blast map_anim (C:1563, 72/72). */
const ARTILLERY_BLAST_ID = 8352;
const ARTILLERY_BLAST_RANGE = 15;
/** `synth_sound` with `delay` = the projectile's `endtime`, on every Shockwave cast (C:2414, 63/63). */
const SHOCKWAVE_ID = 5774;

/**
 * The intermission's accepted Continue: `synth_sound`, no delay, on Tk itself, with Minimus's `del`
 * and the interface close (A:832, B:1857, C:1446, K:3987; 32/32 accepts, none on a refused
 * Continue). The server sends it: the Continue button's ClientScript plays nothing
 * (`[proc,script4932]`), so it sounds on the accepting tick, five ticks before the wave starts.
 */
const MODIFIER_CONFIRMED_ID = 8010;

export const solHereditAudioRules: Record<string, SoundRule> = {
  [COLOSSEUM_MODIFIER_CONFIRMED_EVENT]: { resolve: MODIFIER_CONFIRMED_ID },
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

      for (const cue of event.graphics) {
        if (cue.target.kind !== 'tile') continue;
        if (cue.spotAnimId === COLOSSEUM_SPOTANIMS.javelinArtilleryShadow) {
          const delayCycles = Math.max(0, cue.delayCycles - ARTILLERY_SHADOW_MAP_ANIM_DELAY_CYCLES);
          sounds.push({ id: ARTILLERY_WARNING_ID, delayCycles, channel: 'sfx' });
        } else if (cue.spotAnimId === COLOSSEUM_SPOTANIMS.javelinArtilleryBlast) {
          sounds.push({
            id: ARTILLERY_BLAST_ID,
            position: [...cue.target.position],
            range: ARTILLERY_BLAST_RANGE,
            channel: 'area',
          });
        }
      }
      for (const projectile of event.projectiles) {
        if (projectile.spotAnimId === COLOSSEUM_SPOTANIMS.javelinSpearhead) {
          sounds.push({ id: JAVELIN_THROW_ID, delayCycles: projectile.endDelayCycles, channel: 'sfx' });
        } else if (projectile.spotAnimId === COLOSSEUM_SPOTANIMS.shockwaveProjectile) {
          sounds.push({ id: SHOCKWAVE_ID, delayCycles: projectile.endDelayCycles, channel: 'sfx' });
        }
      }
      return sounds.length > 0 ? play(sounds) : silent;
    },
    preloadIds: [
      ...MOLTEN_SAND.map((sound) => sound.id),
      BEAM_FIRE_ID,
      JAVELIN_THROW_ID,
      ARTILLERY_WARNING_ID,
      ARTILLERY_BLAST_ID,
      SHOCKWAVE_ID,
    ],
  },
};
