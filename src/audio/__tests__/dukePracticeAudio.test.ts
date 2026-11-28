import { describe, expect, it, vi } from 'vitest';
import { DUKE_BILE_CAPTURE } from '../../encounters/dukePractice/__tests__/fixtures/dukeBileCapture';
import {
  DUKE_ENRAGED_MAGIC_CAPTURE,
  DUKE_FLARE_SOUNDS,
  DUKE_SLAM_CAPTURE,
} from '../../encounters/dukePractice/__tests__/fixtures/dukeCombatCapture';
import { DUKE_PRACTICE_AUDIO_EVENT, type DukePracticeAudioCue } from '../../encounters/dukePractice/audioCues';
import type { AudioEngine } from '../AudioEngine';
import { dukePracticeAudioRules } from '../dukePracticeAudio';
import { EventAudioPlayer } from '../EventAudioPlayer';

const expectedIds: Record<DukePracticeAudioCue, number[]> = {
  feed: [7249],
  wake: [7201, 7166],
  slamWindup: DUKE_SLAM_CAPTURE.sounds.map(({ id }) => id),
  spikes: [7213],
  slam: [],
  gazeWindup: [7215, 7205, 7206, 7228, 7208, 7175, 7195, 7239, 7163, 7190],
  gaze: [],
  magicLaunch: DUKE_ENRAGED_MAGIC_CAPTURE.sounds.map(({ id }) => id),
  magicFastLaunch: DUKE_ENRAGED_MAGIC_CAPTURE.sounds.map(({ id }) => id),
  magic: [7197],
  ventLaunch: DUKE_FLARE_SOUNDS.map(({ id }) => id),
  vent: [7243],
  ventIdle: [3052, 7226],
  gasSpitLaunch: [7242],
  gasSpit: [7174],
  bile: DUKE_BILE_CAPTURE.sounds.map(({ id }) => id),
  orbSpawn: [6545],
  orbHit: [179],
  dukeHit: [7181],
  defeat: [7238, 7171],
};

function audioPlayer() {
  const play = vi.fn();
  const player = new EventAudioPlayer({ play } as unknown as AudioEngine, dukePracticeAudioRules);
  return { play, player };
}

describe('Duke practice audio', () => {
  it('plays the supplied cache ID for each combat cue', () => {
    const { play, player } = audioPlayer();
    const events = Object.keys(expectedIds).map((cue, index) => ({
      type: DUKE_PRACTICE_AUDIO_EVENT,
      eventId: index + 1,
      tick: index + 1,
      cue,
    }));
    player.onEvents(events, [31, 52]);
    expect(play.mock.calls.map(([id]) => id)).toEqual(Object.values(expectedIds).flat());
  });

  it('plays the captured melee cues from Duke', () => {
    const { play, player } = audioPlayer();
    player.onEvents(
      [{ type: DUKE_PRACTICE_AUDIO_EVENT, eventId: 1, tick: 6, cue: 'slamWindup', position: [31, 55] }],
      [31, 50],
    );
    expect(play.mock.calls.map(([id, options]) => [id, options.delayMs ?? 0, options.channel])).toEqual(
      DUKE_SLAM_CAPTURE.sounds.map(({ id, cycle }) => [id, cycle * 20, 'area']),
    );
    player.onEvents([{ type: DUKE_PRACTICE_AUDIO_EVENT, eventId: 2, tick: 9, cue: 'slam' }], [31, 50]);
    expect(play).toHaveBeenCalledTimes(DUKE_SLAM_CAPTURE.sounds.length);
  });

  it('plays the captured magic charge and release with their cycle offsets', () => {
    const { play, player } = audioPlayer();
    player.onEvents(
      [{ type: DUKE_PRACTICE_AUDIO_EVENT, eventId: 1, tick: 6, cue: 'magicLaunch', position: [31, 55] }],
      [31, 50],
    );
    expect(play.mock.calls.map(([id, options]) => [id, options.delayMs, options.channel])).toEqual(
      DUKE_ENRAGED_MAGIC_CAPTURE.sounds.map(({ id, cycle }) => [id, cycle * 20, 'area']),
    );
  });

  it('plays the captured bile cue locally and the spit sounds from Duke', () => {
    const { play, player } = audioPlayer();
    const dukePosition = [31, 55] as const;
    player.onEvents(
      [{ type: DUKE_PRACTICE_AUDIO_EVENT, eventId: 1, tick: 22, cue: 'bile', position: dukePosition }],
      [31, 51],
    );
    expect(play.mock.calls.map(([id, options]) => [id, options.delayMs ?? 0, options.channel])).toEqual(
      DUKE_BILE_CAPTURE.sounds.map(({ id, cycle, channel }) => [id, cycle * 20, channel]),
    );
    expect(play.mock.calls[0][1].volume).toBe(1);
    expect(play.mock.calls[1][1].volume).toBeLessThan(1);
  });

  it('plays the gas flare warning locally and its spit sounds from Duke', () => {
    const { play, player } = audioPlayer();
    player.onEvents(
      [{ type: DUKE_PRACTICE_AUDIO_EVENT, eventId: 1, tick: 50, cue: 'ventLaunch', position: [31, 55] }],
      [31, 50],
    );
    expect(play.mock.calls.map(([id, options]) => [id, options.delayMs ?? 0, options.channel])).toEqual(
      DUKE_FLARE_SOUNDS.map(({ id, cycle, channel }) => [id, cycle * 20, channel]),
    );
    expect(play.mock.calls[0][1].volume).toBe(1);
    expect(play.mock.calls[1][1].volume).toBeLessThan(1);
  });

  it('plays the hit, death roar and slouch as area audio at their captured offsets', () => {
    const { play, player } = audioPlayer();
    player.onEvents(
      [
        { type: DUKE_PRACTICE_AUDIO_EVENT, eventId: 1, tick: 64, cue: 'dukeHit', position: [31, 55] },
        { type: DUKE_PRACTICE_AUDIO_EVENT, eventId: 2, tick: 64, cue: 'defeat', position: [31, 55] },
      ],
      [31, 51],
    );
    expect(play.mock.calls.map(([id, options]) => [id, options.delayMs ?? 0, options.channel])).toEqual([
      [7181, 0, 'area'],
      [7238, 20, 'area'],
      [7171, 1200, 'area'],
    ]);
  });

  it('plays the gaze warning locally and the voice and vent cues at their positions', () => {
    const { play, player } = audioPlayer();
    player.onEvents(
      [
        { type: DUKE_PRACTICE_AUDIO_EVENT, eventId: 1, tick: 34, cue: 'gazeWindup', position: [33, 25] },
        { type: DUKE_PRACTICE_AUDIO_EVENT, eventId: 2, tick: 35, cue: 'vent', position: [33, 25] },
        { type: DUKE_PRACTICE_AUDIO_EVENT, eventId: 3, tick: 36, cue: 'ventIdle', position: [33, 25] },
        { type: DUKE_PRACTICE_AUDIO_EVENT, eventId: 4, tick: 36, cue: 'invalid' },
      ],
      [33, 25],
    );
    expect(play.mock.calls[0]).toEqual([7215, { channel: 'sfx', volume: 1 }, 'event:duke_practice_audio']);
    expect(play.mock.calls[1]).toEqual([
      7205,
      { channel: 'area', volume: 1, delayMs: 700 },
      'event:duke_practice_audio',
    ]);
    expect(play.mock.calls.slice(-3).map(([id, options]) => [id, options.channel, options.delayMs ?? 0])).toEqual([
      [7243, 'area', 80],
      [3052, 'area', 0],
      [7226, 'area', 80],
    ]);
  });

  it('uses short-range area audio for orb spawning and contact', () => {
    const { play, player } = audioPlayer();
    const events = [
      { type: DUKE_PRACTICE_AUDIO_EVENT, eventId: 1, tick: 247, cue: 'orbSpawn', position: [26, 51] },
      { type: DUKE_PRACTICE_AUDIO_EVENT, eventId: 2, tick: 256, cue: 'orbHit', position: [35, 51] },
    ];
    player.onEvents(events, [30, 52]);
    expect(play).not.toHaveBeenCalled();
    player.onEvents(events.slice(0, 1), [27, 51]);
    player.onEvents(events.slice(1), [34, 51]);
    expect(play.mock.calls.map(([id, options]) => [id, options.channel])).toEqual([
      [6545, 'area'],
      [179, 'area'],
    ]);
  });
});
