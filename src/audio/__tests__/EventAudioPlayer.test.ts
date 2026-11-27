import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvent } from '../../core/events/types';
import { AudioEngine } from '../AudioEngine';
import { MAX_ATTENUATION_RANGE } from '../constants';
import type { SoundRule } from '../EventAudioPlayer';
import { EventAudioPlayer, pass, play, silent } from '../EventAudioPlayer';

describe('EventAudioPlayer', () => {
  let mockAudioEngine: { play: ReturnType<typeof vi.fn>; preloadSounds: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockAudioEngine = {
      play: vi.fn(),
      preloadSounds: vi.fn().mockResolvedValue(undefined),
    };
  });

  function createPlayer(...ruleSets: Record<string, SoundRule>[]): EventAudioPlayer {
    const layers = ruleSets.map((rules, i) => ({ name: `test-layer-${i}`, rules }));
    return new EventAudioPlayer(mockAudioEngine as unknown as AudioEngine, ...layers);
  }

  describe('setDispatchLayers', () => {
    const died: GameEvent = { type: 'actor_died', eventId: 1, tick: 0, actorId: 'player' };
    // Layer 0 silences deaths, as a rule for an event it does not own may; layers 1 and 2 play one.
    const scoped = () =>
      createPlayer(
        { actor_died: { resolve: () => silent } },
        { actor_died: { resolve: 1 } },
        { actor_died: { resolve: 2 } },
      );
    const playedIds = () => mockAudioEngine.play.mock.calls.map(([id]) => id);

    it('dispatches only through the named layers, in constructor order', () => {
      const player = scoped();
      player.setDispatchLayers(['test-layer-2', 'test-layer-1']);
      player.onEvents([died], [31, 37]);

      expect(playedIds()).toEqual([1]);
    });

    it("never lets a layer outside the scope swallow another layer's sound", () => {
      const player = scoped();
      player.onEvents([died], [31, 37]);
      player.setDispatchLayers(['test-layer-2']);
      player.onEvents([died], [31, 37]);
      player.setDispatchLayers(null);
      player.onEvents([died], [31, 37]);

      // Every layer at first and again after null: layer 0 silences; scoped to layer 2, it plays.
      expect(playedIds()).toEqual([2]);
    });

    it('still preloads every layer while scoped', () => {
      const player = createPlayer({ actor_died: { resolve: 1 } }, { item_dropped: { resolve: 2, preloadIds: [3] } });
      player.setDispatchLayers(['test-layer-0']);

      expect(player.getAllSoundIds().sort()).toEqual([1, 2, 3]);
    });

    it('rejects a layer it was not built with, leaving the scope unchanged', () => {
      const player = scoped();
      player.setDispatchLayers(['test-layer-1']);

      expect(() => player.setDispatchLayers(['test-layer-1', 'missing'])).toThrow('missing');
      player.onEvents([died], [31, 37]);
      expect(playedIds()).toEqual([1]);
    });
  });

  describe('onEvents', () => {
    it('plays a static sound for a matching event', () => {
      const player = createPlayer({
        actor_died: { resolve: 157 },
      });

      const event: GameEvent = { type: 'actor_died', eventId: 1, tick: 0, actorId: 'player' };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).toHaveBeenCalledWith(157, { channel: 'sfx', volume: 1 }, 'event:actor_died');
    });

    it('plays all static sounds when a rule provides multiple IDs', () => {
      const player = createPlayer({
        actor_died: { resolve: [5046, 5015] },
      });

      const event: GameEvent = { type: 'actor_died', eventId: 1, tick: 0, actorId: 'player' };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).toHaveBeenCalledTimes(2);
      expect(mockAudioEngine.play).toHaveBeenNthCalledWith(1, 5046, { channel: 'sfx', volume: 1 }, 'event:actor_died');
      expect(mockAudioEngine.play).toHaveBeenNthCalledWith(2, 5015, { channel: 'sfx', volume: 1 }, 'event:actor_died');
    });

    it('supports delayed timed sounds from a single event', () => {
      const player = createPlayer({
        actor_died: {
          resolve: [
            { id: 10313, delayCycles: 21 },
            { id: 10322, delayCycles: 81 },
          ],
        },
      });

      const event: GameEvent = { type: 'actor_died', eventId: 1, tick: 0, actorId: 'player' };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).toHaveBeenCalledTimes(2);
      expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
        1,
        10313,
        { channel: 'sfx', volume: 1, delayMs: 420 },
        'event:actor_died',
      );
      expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
        2,
        10322,
        { channel: 'sfx', volume: 1, delayMs: 1620 },
        'event:actor_died',
      );
    });

    it('plays a dynamically resolved sound', () => {
      const player = createPlayer({
        attack_started: {
          resolve: (event: GameEvent) => {
            const kind = (event as Record<string, unknown>).attackKind;
            return kind === 'melee_slash' ? play(2727) : silent;
          },
          preloadIds: [2727],
        },
      });

      const event: GameEvent = {
        type: 'attack_started',
        eventId: 1,
        tick: 0,
        sourceId: 'player',
        targetId: 'yama',
        style: 'melee',
        attackKind: 'melee_slash',
      };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).toHaveBeenCalledWith(2727, { channel: 'sfx', volume: 1 }, 'event:attack_started');
    });

    it('plays all dynamically resolved sounds in resolver order', () => {
      const player = createPlayer({
        attack_started: {
          resolve: (event: GameEvent) => {
            const kind = (event as Record<string, unknown>).attackKind;
            return kind === 'magic_shadow' ? play([5046, 5015]) : silent;
          },
          preloadIds: [5046, 5015],
        },
      });

      const event: GameEvent = {
        type: 'attack_started',
        eventId: 1,
        tick: 0,
        sourceId: 'player',
        targetId: 'yama',
        style: 'magic',
        attackKind: 'magic_shadow',
      };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).toHaveBeenCalledTimes(2);
      expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
        1,
        5046,
        { channel: 'sfx', volume: 1 },
        'event:attack_started',
      );
      expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
        2,
        5015,
        { channel: 'sfx', volume: 1 },
        'event:attack_started',
      );
    });

    it('skips events with no matching rule', () => {
      const player = createPlayer({
        actor_died: { resolve: 157 },
      });

      const event: GameEvent = { type: 'unknown_event', eventId: 1, tick: 0 };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).not.toHaveBeenCalled();
    });

    it('skips events when resolver returns pass and no fallback exists', () => {
      const player = createPlayer({
        attack_started: {
          resolve: () => pass,
          preloadIds: [2727],
        },
      });

      const event: GameEvent = {
        type: 'attack_started',
        eventId: 1,
        tick: 0,
        sourceId: 'player',
        targetId: 'yama',
        style: 'melee',
        attackKind: 'typeless',
      };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).not.toHaveBeenCalled();
    });

    it('skips events when resolver returns an empty sound list', () => {
      const player = createPlayer({
        attack_started: {
          resolve: () => play([]),
          preloadIds: [2727],
        },
      });

      const event: GameEvent = {
        type: 'attack_started',
        eventId: 1,
        tick: 0,
        sourceId: 'player',
        targetId: 'yama',
        style: 'melee',
        attackKind: 'typeless',
      };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).not.toHaveBeenCalled();
    });

    it('applies distance attenuation for positional events', () => {
      const player = createPlayer({
        fireball_spawned: {
          resolve: (event: GameEvent) =>
            play(3914, {
              position: (event as Record<string, unknown>).targetPosition as [number, number],
            }),
        },
      });

      const halfRange = MAX_ATTENUATION_RANGE / 2;
      const event: GameEvent = {
        type: 'fireball_spawned',
        eventId: 1,
        tick: 0,
        sourceId: 'yama',
        targetPosition: [31, 37 + halfRange],
        fireballIndex: 0,
      };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).toHaveBeenCalledTimes(1);
      const volume = mockAudioEngine.play.mock.calls[0][1].volume;
      expect(volume).toBeCloseTo((MAX_ATTENUATION_RANGE - (halfRange - 1)) / MAX_ATTENUATION_RANGE, 10);
    });

    it('skips positional sounds at max range (zero volume)', () => {
      const player = createPlayer({
        fireball_spawned: {
          resolve: (event: GameEvent) =>
            play(3914, {
              position: (event as Record<string, unknown>).targetPosition as [number, number],
            }),
        },
      });

      const event: GameEvent = {
        type: 'fireball_spawned',
        eventId: 1,
        tick: 0,
        sourceId: 'yama',
        targetPosition: [31, 37 + MAX_ATTENUATION_RANGE + 1],
        fireballIndex: 0,
      };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).not.toHaveBeenCalled();
    });

    it('applies rule and per-sound range, position, and channel overrides independently', () => {
      const player = createPlayer({
        actor_died: {
          resolve: () =>
            play([100, { id: 200, position: [10, 0], range: 10 }, { id: 300, position: null, channel: 'sfx' }], {
              position: [15, 0],
              range: 15,
            }),
        },
      });

      const event: GameEvent = { type: 'actor_died', eventId: 1, tick: 0, actorId: 'player' };
      player.onEvents([event], [5, 0]);

      expect(mockAudioEngine.play.mock.calls[0]?.[1]?.volume).toBeCloseTo((15 - 9) / 15, 10);
      expect(mockAudioEngine.play.mock.calls[0]?.[1]?.channel).toBe('area');
      expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
        2,
        200,
        { channel: 'area', volume: (10 - 4) / 10 },
        'event:actor_died',
      );
      expect(mockAudioEngine.play).toHaveBeenNthCalledWith(3, 300, { channel: 'sfx', volume: 1 }, 'event:actor_died');
    });

    it('applies volume multiplier from rule', () => {
      const player = createPlayer({
        actor_died: { resolve: () => play(157, { volume: 0.5 }) },
      });

      const event: GameEvent = { type: 'actor_died', eventId: 1, tick: 0, actorId: 'player' };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).toHaveBeenCalledWith(157, { channel: 'sfx', volume: 0.5 }, 'event:actor_died');
    });

    it('first layer handler wins over second layer', () => {
      const player = createPlayer({ actor_died: { resolve: 200 } }, { actor_died: { resolve: 100 } });

      const event: GameEvent = { type: 'actor_died', eventId: 1, tick: 0, actorId: 'player' };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).toHaveBeenCalledWith(200, { channel: 'sfx', volume: 1 }, 'event:actor_died');
    });

    it('handler returning pass falls through to next layer', () => {
      const player = createPlayer({ actor_died: { resolve: () => pass } }, { actor_died: { resolve: 100 } });

      const event: GameEvent = { type: 'actor_died', eventId: 1, tick: 0, actorId: 'player' };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).toHaveBeenCalledWith(100, { channel: 'sfx', volume: 1 }, 'event:actor_died');
    });

    it('handler returning silent stops chain without playing', () => {
      const player = createPlayer({ actor_died: { resolve: () => silent } }, { actor_died: { resolve: 100 } });

      const event: GameEvent = { type: 'actor_died', eventId: 1, tick: 0, actorId: 'player' };
      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).not.toHaveBeenCalled();
    });
  });

  describe('getAllSoundIds', () => {
    it('collects static sound IDs from rules', () => {
      const player = createPlayer({
        actor_died: { resolve: 157 },
        fireball_spawned: { resolve: 3914 },
      });

      const ids = player.getAllSoundIds();
      expect(ids).toContain(157);
      expect(ids).toContain(3914);
    });

    it('collects static sound IDs from array rules', () => {
      const player = createPlayer({
        actor_died: { resolve: [5046, 5015] },
      });

      const ids = player.getAllSoundIds();
      expect(ids).toContain(5046);
      expect(ids).toContain(5015);
    });

    it('collects static sound IDs from timed sound entries', () => {
      const player = createPlayer({
        actor_died: {
          resolve: [
            { id: 10313, delayCycles: 21 },
            { id: 10322, delayCycles: 81 },
          ],
        },
      });

      const ids = player.getAllSoundIds();
      expect(ids).toContain(10313);
      expect(ids).toContain(10322);
    });

    it('collects preloadIds from dynamic rules', () => {
      const player = createPlayer({
        attack_started: {
          resolve: () => pass,
          preloadIds: [2727, 2725, 2726],
        },
      });

      const ids = player.getAllSoundIds();
      expect(ids).toContain(2727);
      expect(ids).toContain(2725);
      expect(ids).toContain(2726);
    });

    it('preloadIds are unioned across all layers for same event type', () => {
      const player = createPlayer(
        { attack_started: { resolve: () => pass, preloadIds: [100, 200] } },
        { attack_started: { resolve: 300, preloadIds: [200, 400] } },
      );

      const ids = player.getAllSoundIds();
      expect(ids).toContain(100);
      expect(ids).toContain(200);
      expect(ids).toContain(300);
      expect(ids).toContain(400);
    });

    it('deduplicates sound IDs', () => {
      const player = createPlayer({ a: { resolve: 100 } }, { b: { resolve: 100, preloadIds: [100, 200] } });

      const ids = player.getAllSoundIds();
      expect(ids.filter((id) => id === 100)).toHaveLength(1);
      expect(ids).toContain(200);
    });
  });

  describe('preload', () => {
    it('preloads all sound IDs from rules', async () => {
      const player = createPlayer({
        actor_died: { resolve: 157 },
        attack_started: { resolve: () => pass, preloadIds: [2727] },
      });

      await player.preload();

      expect(mockAudioEngine.preloadSounds).toHaveBeenCalledTimes(1);
      const preloadedIds = mockAudioEngine.preloadSounds.mock.calls[0][0] as number[];
      expect(preloadedIds).toContain(157);
      expect(preloadedIds).toContain(2727);
    });
  });

  describe('reset', () => {
    it('keeps live event playback available after reset', () => {
      const player = createPlayer({ actor_died: { resolve: 157 } });
      player.reset();

      player.onEvents([{ type: 'actor_died', eventId: 1, tick: 0, actorId: 'player' }], [31, 37]);

      expect(mockAudioEngine.play).toHaveBeenCalledWith(157, { channel: 'sfx', volume: 1 }, 'event:actor_died');
    });
  });
});

describe('EventAudioPlayer replay cue clock', () => {
  const event: GameEvent = { type: 'actor_died', eventId: 1, tick: 10, actorId: 'player' };
  let engine: AudioEngine;
  let player: EventAudioPlayer;

  beforeEach(() => {
    engine = new AudioEngine();
    vi.spyOn(engine, 'play').mockImplementation(() => {});
    player = new EventAudioPlayer(engine, {
      name: 'delayed',
      rules: { actor_died: { resolve: { id: 10313, delayCycles: 21 } } },
    });
  });

  afterEach(() => {
    engine.dispose();
    vi.restoreAllMocks();
  });

  it.each([0.5, 1, 2])('waits for the replay onset boundary at %sx', (speed) => {
    player.updateReplayClock(6000);
    player.onEvents([event], [31, 37]);

    player.updateReplayClock(6000 + (420 / speed - 1) * speed);

    expect(engine.play).not.toHaveBeenCalled();
  });

  it.each([0.5, 1, 2])('plays without a second wall delay at the replay boundary at %sx', (speed) => {
    player.updateReplayClock(6000);
    player.onEvents([event], [31, 37]);

    player.updateReplayClock(6000 + (420 / speed) * speed);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(10313, { channel: 'sfx', volume: 1 }, 'event:actor_died');
  });

  it('anchors the cue to the event tick when its first render is already partway through the tick', () => {
    player.updateReplayClock(6250);
    player.onEvents([event], [31, 37]);

    player.updateReplayClock(6420);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(10313, { channel: 'sfx', volume: 1 }, 'event:actor_died');
  });

  it('plays an already-due cue immediately when its event arrives late', () => {
    player.updateReplayClock(6500);

    player.onEvents([event], [31, 37]);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(10313, { channel: 'sfx', volume: 1 }, 'event:actor_died');
  });

  it('follows a speed change while the cue is pending', () => {
    player.updateReplayClock(6000);
    player.onEvents([event], [31, 37]);
    player.updateReplayClock(6000 + 100 * 0.5);

    player.updateReplayClock(6050 + 185 * 2);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(10313, { channel: 'sfx', volume: 1 }, 'event:actor_died');
  });

  it('holds a due cue when the replay clock is paused', () => {
    player.updateReplayClock(6000);
    player.onEvents([event], [31, 37]);
    engine.stopAll();

    player.updateReplayClock(6420, true);

    expect(engine.play).not.toHaveBeenCalled();
  });

  it('retains future onsets when ordinary pause stops the audio engine', () => {
    player.updateReplayClock(6000);
    player.onEvents([event], [31, 37]);
    player.updateReplayClock(6100, true);
    engine.stopAll();
    player.updateReplayClock(6100, true);
    player.updateReplayClock(6100);

    player.updateReplayClock(6420);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(10313, { channel: 'sfx', volume: 1 }, 'event:actor_died');
  });

  it('does not replay a consumed cue when the same clock time is published again', () => {
    player.updateReplayClock(6000);
    player.onEvents([event], [31, 37]);
    player.updateReplayClock(6420);
    vi.mocked(engine.play).mockClear();

    player.updateReplayClock(6420);

    expect(engine.play).not.toHaveBeenCalled();
  });

  it('orders pending onsets by due time and preserves insertion order for simultaneous cues', () => {
    const orderedPlayer = new EventAudioPlayer(engine, {
      name: 'overlapping',
      rules: {
        actor_died: {
          resolve: [
            { id: 1, delayCycles: 40 },
            { id: 2, delayCycles: 21 },
          ],
        },
        item_dropped: {
          resolve: [
            { id: 3, delayCycles: 10 },
            { id: 4, delayCycles: 21 },
          ],
        },
      },
    });
    orderedPlayer.updateReplayClock(6000);
    orderedPlayer.onEvents([event], [31, 37]);
    orderedPlayer.onEvents(
      [{ type: 'item_dropped', eventId: 2, tick: 10, itemId: 4151, position: [31, 37] }],
      [31, 37],
    );

    orderedPlayer.updateReplayClock(6800);

    expect(vi.mocked(engine.play).mock.calls.map(([id]) => id)).toEqual([3, 2, 4, 1]);
  });

  it('preserves resolved attenuation and channel when a delayed replay cue becomes due', () => {
    const areaPlayer = new EventAudioPlayer(engine, {
      name: 'area',
      rules: {
        actor_died: {
          resolve: () => play({ id: 10313, delayCycles: 21 }, { position: [15, 0], range: 15, volume: 0.5 }),
        },
      },
    });
    areaPlayer.updateReplayClock(6000);
    areaPlayer.onEvents([event], [5, 0]);

    areaPlayer.updateReplayClock(6420);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(10313, { channel: 'area', volume: 0.2 }, 'event:actor_died');
  });

  it('cancels pending cues when the event player is reset', () => {
    player.updateReplayClock(6000);
    player.onEvents([event], [31, 37]);
    player.reset();

    player.updateReplayClock(7000);

    expect(engine.play).not.toHaveBeenCalled();
  });

  it('cancels pending cues when the compositor returns to live time', () => {
    player.updateReplayClock(6000);
    player.onEvents([event], [31, 37]);
    player.updateReplayClock(null);

    player.updateReplayClock(7000);

    expect(engine.play).not.toHaveBeenCalled();
  });

  it('retains direct wall-delay scheduling for live events after replay reset', () => {
    player.updateReplayClock(6000);
    player.reset();

    player.onEvents([event], [31, 37]);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(
      10313,
      { channel: 'sfx', volume: 1, delayMs: 420 },
      'event:actor_died',
    );
  });

  it.each([
    { name: 'master', channel: 'sfx', mute: (value: number) => engine.setMasterVolume(value) },
    { name: 'sfx', channel: 'sfx', mute: (value: number) => engine.setSfxVolume(value) },
    { name: 'area', channel: 'area', mute: (value: number) => engine.setAreaVolume(value) },
    { name: 'focus', channel: 'sfx', mute: (value: number) => engine.setFocusSuspended(value === 0) },
  ] as const)('does not revive a cue launched under $name mute when sound is restored', ({ channel, mute }) => {
    const mutedPlayer = new EventAudioPlayer(engine, {
      name: 'muted',
      rules: { actor_died: { resolve: { id: 10313, delayCycles: 21, channel } } },
    });
    mutedPlayer.updateReplayClock(6000);
    mute(0);
    mutedPlayer.onEvents([event], [31, 37]);

    mute(1);
    mutedPlayer.updateReplayClock(6420);

    expect(engine.play).not.toHaveBeenCalled();
  });

  it('gates only the resolved muted channel when one event mixes area and unpositioned sounds', () => {
    const mixedPlayer = new EventAudioPlayer(engine, {
      name: 'mixed',
      rules: {
        actor_died: {
          resolve: () =>
            play(
              [
                { id: 1, delayCycles: 21 },
                { id: 2, delayCycles: 21, position: null },
              ],
              { position: [31, 37] },
            ),
        },
      },
    });
    engine.setAreaVolume(0);
    mixedPlayer.updateReplayClock(6000);
    mixedPlayer.onEvents([event], [31, 37]);
    engine.setAreaVolume(1);

    mixedPlayer.updateReplayClock(6420);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(2, { channel: 'sfx', volume: 1 }, 'event:actor_died');
  });

  it('leaves live mute decisions and wall-delay scheduling at AudioEngine', () => {
    engine.setMasterVolume(0);

    player.onEvents([event], [31, 37]);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(
      10313,
      { channel: 'sfx', volume: 1, delayMs: 420 },
      'event:actor_died',
    );
  });

  describe('finishReplay', () => {
    it.each([
      { speed: 0.5, delayMs: 640 },
      { speed: 1, delayMs: 320 },
      { speed: 2, delayMs: 160 },
    ])('hands off the remaining tail delay at $speed x when playback ends', ({ speed, delayMs }) => {
      player.updateReplayClock(6000);
      player.onEvents([event], [31, 37]);
      player.updateReplayClock(6100);

      player.finishReplay(speed);

      expect(engine.play).toHaveBeenCalledExactlyOnceWith(
        10313,
        { channel: 'sfx', volume: 1, delayMs },
        'event:actor_died',
      );
    });

    it('preserves options and simultaneous-cue order when onsets extend beyond the last visual tick', () => {
      const tailPlayer = new EventAudioPlayer(engine, {
        name: 'tail',
        rules: {
          actor_died: {
            resolve: () =>
              play(
                [
                  { id: 9, delayCycles: 100, channel: 'sfx' },
                  { id: 2, delayCycles: 80 },
                  { id: 3, delayCycles: 80 },
                ],
                { channel: 'area', volume: 0.4 },
              ),
          },
        },
      });
      tailPlayer.updateReplayClock(6000);
      tailPlayer.onEvents([event], [31, 37]);
      tailPlayer.updateReplayClock(7200);

      tailPlayer.finishReplay(2);

      expect(vi.mocked(engine.play).mock.calls).toEqual([
        [2, { channel: 'area', volume: 0.4, delayMs: 200 }, 'event:actor_died'],
        [3, { channel: 'area', volume: 0.4, delayMs: 200 }, 'event:actor_died'],
        [9, { channel: 'sfx', volume: 0.4, delayMs: 400 }, 'event:actor_died'],
      ]);
    });

    it('does not schedule a tail again when completion is reported twice', () => {
      player.updateReplayClock(6000);
      player.onEvents([event], [31, 37]);
      player.finishReplay(1);
      vi.mocked(engine.play).mockClear();

      player.finishReplay(1);

      expect(engine.play).not.toHaveBeenCalled();
    });

    it('removes handed-off cues from the game-clock queue when a later clock update arrives', () => {
      player.updateReplayClock(6000);
      player.onEvents([event], [31, 37]);
      player.finishReplay(1);
      vi.mocked(engine.play).mockClear();

      player.updateReplayClock(7000);

      expect(engine.play).not.toHaveBeenCalled();
    });

    it('leaves already-started sounds alone when playback ends', () => {
      player.updateReplayClock(6000);
      player.onEvents([event], [31, 37]);
      player.updateReplayClock(6420);
      vi.mocked(engine.play).mockClear();
      const stopAll = vi.spyOn(engine, 'stopAll');

      player.finishReplay(2);

      expect(engine.play).not.toHaveBeenCalled();
      expect(stopAll).not.toHaveBeenCalled();
    });

    it('does not revive canceled cues when completion follows a replay reset', () => {
      player.updateReplayClock(6000);
      player.onEvents([event], [31, 37]);
      player.reset();

      player.finishReplay(1);

      expect(engine.play).not.toHaveBeenCalled();
    });

    it('hands off only the new recording cues when reset separates two replays', () => {
      player.updateReplayClock(6000);
      player.onEvents([event], [31, 37]);
      player.reset();
      player.updateReplayClock(12000);
      player.onEvents([{ ...event, eventId: 2, tick: 20 }], [31, 37]);
      player.updateReplayClock(12100);

      player.finishReplay(1);

      expect(engine.play).toHaveBeenCalledExactlyOnceWith(
        10313,
        { channel: 'sfx', volume: 1, delayMs: 320 },
        'event:actor_died',
      );
    });
  });
});
