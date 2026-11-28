import { DUKE_CENTER_TILE } from '../encounters/duke/arena';
import type { DukeAudioCue } from '../encounters/duke/audioCues';
import { DUKE_AUDIO_EVENT } from '../types/duke';
import { coordinateFrom, play, type SoundRule, silent, type TimedSound } from './EventAudioPlayer';

// The catalog, cache clips, and captured casts supply these cues.
// See docs/encounters/duke-facts-spec.md for timing and sources.
const FAST_SPIT_SOUNDS = [
  { id: 7179, delayCycles: 1 },
  { id: 7248, delayCycles: 35 },
];
const MAGIC_LAUNCH_SOUNDS = [
  { id: 7161, delayCycles: 1 },
  { id: 7214, delayCycles: 50 },
];
const CUE_SOUNDS: Record<DukeAudioCue, number | TimedSound[] | null> = {
  feed: 7249, // Regular feed, capture ticks 104–105.
  wake: [
    { id: 7201, delayCycles: 1 },
    { id: 7166, delayCycles: 45 },
  ], // Seq 10179, regular capture lines 6599 and 6658.
  slamWindup: [
    { id: 2707, position: [DUKE_CENTER_TILE[0], DUKE_CENTER_TILE[1] - 3], range: 10 },
    { id: 7177, delayCycles: 5 },
    { id: 7168, delayCycles: 39 },
    { id: 7224, delayCycles: 40 },
  ], // Seq 10176, 20261126-232238-Duke.jsonl windup tick 20.
  spikes: 7213, // Legacy cue
  slam: null,
  gazeWindup: [
    { id: 7215, position: null },
    { id: 7205, delayCycles: 35 },
    { id: 7206, delayCycles: 71 },
    { id: 7228, delayCycles: 85 },
    { id: 7208, delayCycles: 99 },
    { id: 7175, delayCycles: 115 },
    { id: 7195, delayCycles: 124 },
    { id: 7239, delayCycles: 155 },
    { id: 7163, delayCycles: 157 },
    { id: 7190, delayCycles: 164 },
  ], // Seq 10180, capture gaze tick 14.
  gaze: null,
  magicLaunch: MAGIC_LAUNCH_SOUNDS, // Seq 10177 in both phases.
  magicFastLaunch: MAGIC_LAUNCH_SOUNDS, // Legacy enrage replays.
  magic: 7197, // Magic impact
  // 20261127-025030-Duke-Sucellus_10.jsonl:5069–5087. Gas and bile have distinct local warnings.
  ventLaunch: [{ id: 5002, position: null }, ...FAST_SPIT_SOUNDS],
  vent: [{ id: 7243, delayCycles: 4, range: 5 }],
  ventIdle: [
    { id: 3052, range: 3 },
    { id: 7226, delayCycles: 4, range: 5 },
  ], // 20261127-025030-Duke-Sucellus_10.jsonl:5145–5163.
  gasSpitLaunch: 7242, // Spit projectile
  gasSpit: 7174, // Vent smoke
  // 20261126-232238-Duke.jsonl:6566–6590 and :7551–7579.
  bile: [{ id: 1784, position: null }, ...FAST_SPIT_SOUNDS],
  orbSpawn: [{ id: 6545, range: 4 }],
  orbHit: [{ id: 179, range: 4 }],
  dukeHit: [{ id: 7181, range: 10 }],
  defeat: [
    { id: 7238, delayCycles: 1 },
    { id: 7171, delayCycles: 60 },
  ], // Seq 10181, 20261126-235612-Duke-Sucellus.jsonl:5729–5786.
};

function isCue(value: unknown): value is DukeAudioCue {
  return typeof value === 'string' && Object.hasOwn(CUE_SOUNDS, value);
}

export const dukeAudioRules: Record<string, SoundRule> = {
  [DUKE_AUDIO_EVENT]: {
    resolve: (event) => {
      if (event.type !== DUKE_AUDIO_EVENT || !isCue(event.cue)) return silent;
      const sounds = CUE_SOUNDS[event.cue];
      return sounds === null ? silent : play(sounds, { position: coordinateFrom(event.position), range: 15 });
    },
    preloadIds: [
      ...new Set(
        Object.values(CUE_SOUNDS).flatMap((sounds) => {
          if (sounds === null) return [];
          return typeof sounds === 'number' ? [sounds] : sounds.map(({ id }) => id);
        }),
      ),
    ],
  },
};
