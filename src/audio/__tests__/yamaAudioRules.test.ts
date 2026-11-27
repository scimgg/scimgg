import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvent } from '../../core/events/types';
import { SeqType } from '../../rs/config/seqtype/SeqType';
import { AudioEngine } from '../AudioEngine';
import { coreAudioRules } from '../coreAudioRules';
import { EventAudioPlayer } from '../EventAudioPlayer';
import { type ActorFrameState, FrameSoundTracker } from '../FrameSoundTracker';
import { yamaAudioRules } from '../yamaAudioRules';

describe('yamaAudioRules', () => {
  let mockAudioEngine: AudioEngine;

  beforeEach(() => {
    mockAudioEngine = Object.assign(new AudioEngine(), {
      play: vi.fn(),
      preloadSounds: vi.fn().mockResolvedValue(undefined),
    });
  });

  function createPlayer(): EventAudioPlayer {
    return new EventAudioPlayer(mockAudioEngine, yamaAudioRules, coreAudioRules);
  }

  it('plays fireball barrage layered sounds for fireball_spawned', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'fireball_spawned',
      eventId: 1,
      tick: 0,
      sourceId: 'yama',
      targetPosition: [31, 37],
      fireballIndex: 0,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledTimes(3);
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      1,
      9335,
      { channel: 'sfx', volume: 1, delayMs: 60 },
      'event:fireball_spawned',
    );
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      2,
      10255,
      { channel: 'sfx', volume: 1, delayMs: 2000 },
      'event:fireball_spawned',
    );
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      3,
      10268,
      { channel: 'sfx', volume: 1, delayMs: 2100 },
      'event:fireball_spawned',
    );
  });

  it('plays wave ambient sound for wave_activated', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'wave_activated',
      eventId: 2,
      tick: 0,
      position: [31, 37],
      wavePositions: [[17, 0]],
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledWith(10238, { channel: 'sfx', volume: 1 }, 'event:wave_activated');
  });

  // 9315 (`synth_sound 9315, delay=5`) is the Purging staff's Scatter-ashes kill, not a flare
  // (core rule `spec_on_kill`); a flare's death and detonation sound only through its clips'
  // frame sounds.
  it('sends no event sound for a voidflare being destroyed or detonating', () => {
    const player = createPlayer();
    const events: GameEvent[] = [
      {
        type: 'voidflare_destroyed',
        eventId: 3,
        tick: 0,
        flareId: 'a',
        position: [31, 37],
        variant: 'fire',
      },
      {
        type: 'voidflare_exploded',
        eventId: 4,
        tick: 0,
        flareId: 'b',
        position: [31, 37],
        variant: 'shadow',
        damage: 20,
      },
    ];

    player.onEvents(events, [31, 37]);

    expect(mockAudioEngine.play).not.toHaveBeenCalled();
  });

  it.each([
    { style: 'range', attackKind: 'range_shadow' },
    { style: 'magic', attackKind: 'magic_fire' },
    { style: 'magic', attackKind: 'magic_shadow' },
    { style: 'melee', attackKind: 'melee_crush' },
  ] as const)('leaves Yama $attackKind silent through the Yama and core layers', ({ style, attackKind }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 55,
      tick: 0,
      sourceId: 'yama',
      targetId: 'player',
      style,
      attackKind,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).not.toHaveBeenCalled();
  });

  it('plays only the animation sound when a Yama attack reaches its sound frame', () => {
    const player = createPlayer();
    const tracker = new FrameSoundTracker(mockAudioEngine);
    const seqType = new SeqType(12144, {
      name: 'test',
      game: 'oldschool',
      environment: 'live',
      revision: 232,
      timestamp: '',
      size: 0,
    });
    seqType.frameSounds = new Map([[56, [{ id: 10251, loops: 0, location: 10, retain: 5 }]]]);
    const actor: ActorFrameState = {
      actorId: 'yama',
      seqId: 12144,
      currentFrame: 0,
      seqType,
      position: [31, 37],
    };
    tracker.update([actor], [31, 37]);
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 59,
      tick: 0,
      sourceId: 'yama',
      targetId: 'player',
      style: 'magic',
      attackKind: 'magic_fire',
    };

    player.onEvents([event], [31, 37]);
    tracker.update([{ ...actor, currentFrame: 56 }], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledExactlyOnceWith(
      10251,
      { channel: 'area', volume: 1 },
      'frame:seq=12144,f=56',
    );
  });

  it.each([
    { style: 'melee', attackKind: 'melee_slash', soundId: 2500 },
    { style: 'range', attackKind: 'range_arrow', soundId: 2700 },
    { style: 'magic', attackKind: 'magic_fire', soundId: 160 },
  ] as const)('plays player $attackKind through the Yama and core layers', ({ style, attackKind, soundId }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 60,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style,
      attackKind,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledTimes(1);
    expect(mockAudioEngine.play).toHaveBeenCalledWith(soundId, { channel: 'sfx', volume: 1 }, 'event:attack_started');
  });
});
