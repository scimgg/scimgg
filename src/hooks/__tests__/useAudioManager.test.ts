// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, EventAudioPlayer } from '../../audio';
import { decodeLegacyReplayFrames } from '../../core/legacyReplayEvents';
import { LEGACY_INFERNO_EVENTS } from '../../test/helpers/legacyEncounterRecordings';
import { tickBus } from '../../tutorial/runtime/tickBus';
import { resetPageActivityForTests } from '../pageActivity';
import {
  createEventAudioPlayer,
  type UseAudioManagerReturn,
  useAudioManager,
  useEventAudioScope,
} from '../useAudioManager';

let activeAudio: UseAudioManagerReturn | undefined;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetPageActivityForTests();
  activeAudio?.eventAudioPlayerRef.current.reset();
  activeAudio?.audioEngine.stopAll();
  activeAudio?.audioEngine.setFocusSuspended(false);
  activeAudio?.audioEngine.setMasterVolume(1);
  activeAudio?.audioEngine.setSfxVolume(1);
  activeAudio?.audioEngine.setAreaVolume(1);
  activeAudio?.audioEngine.setMetronomeVolume(1);
  activeAudio = undefined;
});

/**
 * Covers the browser focus → audio-engine bridge owned by useAudioManager.
 * The engine's internal state handling is covered in AudioEngine.test.ts;
 * here we verify the listener wiring, toggle re-wiring, and cleanup.
 */
describe('useAudioManager focus suspension wiring', () => {
  let setFocusSuspendedSpy: ReturnType<typeof vi.spyOn>;
  let hiddenValue = false;
  let hasFocusValue = true;

  const setHidden = (value: boolean) => {
    hiddenValue = value;
  };
  const setHasFocus = (value: boolean) => {
    hasFocusValue = value;
  };

  beforeEach(() => {
    hiddenValue = false;
    hasFocusValue = true;

    // Stub the engine method so we observe calls without touching AudioContext.
    setFocusSuspendedSpy = vi.spyOn(AudioEngine.prototype, 'setFocusSuspended').mockImplementation(() => {});

    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hiddenValue);

    vi.spyOn(document, 'hasFocus').mockImplementation(() => hasFocusValue);
  });

  const renderWithMute = (muteWhenUnfocused: boolean) => {
    const hook = renderHook(
      ({ mute }: { mute: boolean }) =>
        useAudioManager({
          areaVolume: 0.1,
          masterVolume: 0.1,
          sfxVolume: 0.1,
          muteWhenUnfocused: mute,
          tickAudioMetronomeEnabled: false,
          tickAudioMetronomeTock: false,
          tickAudioMetronomeVolume: 0.1,
        }),
      { initialProps: { mute: muteWhenUnfocused } },
    );
    activeAudio = hook.result.current;
    return hook;
  };

  it('reports unsuspended on mount when the window is focused and visible', () => {
    renderWithMute(true);

    expect(setFocusSuspendedSpy).toHaveBeenCalledWith(false);
  });

  it('reports suspended on mount when the window is already hidden', () => {
    setHidden(true);

    renderWithMute(true);

    expect(setFocusSuspendedSpy).toHaveBeenCalledWith(true);
  });

  it('stays unsuspended on mount when the page has simply never had focus', () => {
    // Opened from the address bar: visible and in front, but focus is still in the browser chrome.
    setHasFocus(false);

    renderWithMute(true);

    expect(setFocusSuspendedSpy).toHaveBeenLastCalledWith(false);
  });

  it('reports suspended on mount when the window was left before mounting', () => {
    window.dispatchEvent(new Event('blur'));

    renderWithMute(true);

    expect(setFocusSuspendedSpy).toHaveBeenLastCalledWith(true);
  });

  it('suspends on window blur and resumes on window focus', () => {
    renderWithMute(true);
    setFocusSuspendedSpy.mockClear();

    setHasFocus(false);
    window.dispatchEvent(new Event('blur'));
    expect(setFocusSuspendedSpy).toHaveBeenLastCalledWith(true);

    setHasFocus(true);
    window.dispatchEvent(new Event('focus'));
    expect(setFocusSuspendedSpy).toHaveBeenLastCalledWith(false);
  });

  it('suspends on visibilitychange when the tab becomes hidden', () => {
    renderWithMute(true);
    setFocusSuspendedSpy.mockClear();

    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(setFocusSuspendedSpy).toHaveBeenLastCalledWith(true);
  });

  it('does not wire focus listeners when the feature is disabled', () => {
    renderWithMute(false);
    // Mount should force the engine into an unsuspended state.
    expect(setFocusSuspendedSpy).toHaveBeenCalledWith(false);

    setFocusSuspendedSpy.mockClear();
    setHasFocus(false);
    window.dispatchEvent(new Event('blur'));

    expect(setFocusSuspendedSpy).not.toHaveBeenCalled();
  });

  it('force-unsuspends the engine when toggled from ON to OFF while blurred', () => {
    // Start unfocused with the feature on — engine should be suspended.
    setHasFocus(false);
    window.dispatchEvent(new Event('blur'));
    const { rerender } = renderWithMute(true);
    expect(setFocusSuspendedSpy).toHaveBeenLastCalledWith(true);

    setFocusSuspendedSpy.mockClear();

    // User toggles the feature off.
    rerender({ mute: false });

    // Cleanup + re-effect should both drive the engine to unsuspended.
    expect(setFocusSuspendedSpy).toHaveBeenCalledWith(false);
    // And even a subsequent blur should no longer affect the engine.
    setFocusSuspendedSpy.mockClear();
    window.dispatchEvent(new Event('blur'));
    expect(setFocusSuspendedSpy).not.toHaveBeenCalled();
  });

  it('re-wires listeners when toggled from OFF to ON', () => {
    const { rerender } = renderWithMute(false);
    setFocusSuspendedSpy.mockClear();

    // While OFF, events should do nothing.
    setHasFocus(false);
    window.dispatchEvent(new Event('blur'));
    expect(setFocusSuspendedSpy).not.toHaveBeenCalled();

    // Flip back ON — effect should immediately sync state with current focus.
    rerender({ mute: true });
    expect(setFocusSuspendedSpy).toHaveBeenLastCalledWith(true);
  });

  it('removes listeners on unmount', () => {
    const { unmount } = renderWithMute(true);
    unmount();
    setFocusSuspendedSpy.mockClear();

    setHasFocus(false);
    window.dispatchEvent(new Event('blur'));

    expect(setFocusSuspendedSpy).not.toHaveBeenCalled();
  });
});

describe('useAudioManager replay cue cancellation', () => {
  const enabledSettings = {
    areaVolume: 1,
    masterVolume: 1,
    sfxVolume: 1,
    muteWhenUnfocused: true,
    tickAudioMetronomeEnabled: false,
    tickAudioMetronomeTock: false,
    tickAudioMetronomeVolume: 1,
  };
  let focused = true;
  let hidden = false;

  beforeEach(() => {
    focused = true;
    hidden = false;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  });

  function mountAudio(overrides: Partial<typeof enabledSettings> = {}) {
    const hook = renderHook((settings) => useAudioManager(settings), {
      initialProps: { ...enabledSettings, ...overrides },
    });
    activeAudio = hook.result.current;
    const engine = activeAudio.audioEngine;
    const player = new EventAudioPlayer(engine, { actor_died: { resolve: { id: 10313, delayCycles: 21 } } });
    activeAudio.eventAudioPlayerRef.current = player;
    vi.spyOn(engine, 'play').mockImplementation(() => {});
    return { ...hook, engine, player };
  }

  function queueCue(player: EventAudioPlayer): void {
    player.updateReplayClock(6000);
    player.onEvents([{ type: 'actor_died', eventId: 1, tick: 10, actorId: 'player' }], [31, 37]);
  }

  it('discards pending replay cues when master mute is enabled before their onset', () => {
    const { engine, player, rerender } = mountAudio();
    queueCue(player);

    rerender({ ...enabledSettings, masterVolume: 0 });
    rerender(enabledSettings);
    player.updateReplayClock(6420);

    expect(engine.play).not.toHaveBeenCalled();
  });

  it('discards pending replay cues when focus muting is followed by focus restoration', () => {
    const { engine, player } = mountAudio();
    queueCue(player);

    focused = false;
    window.dispatchEvent(new Event('blur'));
    focused = true;
    window.dispatchEvent(new Event('focus'));
    player.updateReplayClock(6420);

    expect(engine.play).not.toHaveBeenCalled();
  });

  it('discards pending replay cues when the document becomes hidden and visible again', () => {
    const { engine, player } = mountAudio();
    queueCue(player);

    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    player.updateReplayClock(6420);

    expect(engine.play).not.toHaveBeenCalled();
  });

  it('does not revive a replay cue launched while master-muted when the user unmutes', () => {
    const { engine, player, rerender } = mountAudio({ masterVolume: 0 });
    queueCue(player);

    rerender(enabledSettings);
    player.updateReplayClock(6420);

    expect(engine.play).not.toHaveBeenCalled();
  });

  it('does not revive a replay cue launched while focus-muted when the window regains focus', () => {
    focused = false;
    window.dispatchEvent(new Event('blur'));
    const { engine, player } = mountAudio();
    queueCue(player);

    focused = true;
    window.dispatchEvent(new Event('focus'));
    player.updateReplayClock(6420);

    expect(engine.play).not.toHaveBeenCalled();
  });

  it('retains future onsets when an ordinary transport pause stops the engine', () => {
    const { engine, player } = mountAudio();
    queueCue(player);

    engine.stopAll();
    player.updateReplayClock(6100, true);
    player.updateReplayClock(6420);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(10313, { channel: 'sfx', volume: 1 }, 'event:actor_died');
  });

  it('retains already-pending channel cues when a channel is unmuted before onset', () => {
    const { engine, player, rerender } = mountAudio();
    queueCue(player);

    rerender({ ...enabledSettings, sfxVolume: 0 });
    rerender(enabledSettings);
    player.updateReplayClock(6420);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(10313, { channel: 'sfx', volume: 1 }, 'event:actor_died');
  });

  it('retains replay cues across focus loss when focus muting is disabled', () => {
    const { engine, player } = mountAudio({ muteWhenUnfocused: false });
    queueCue(player);

    focused = false;
    window.dispatchEvent(new Event('blur'));
    player.updateReplayClock(6420);

    expect(engine.play).toHaveBeenCalledExactlyOnceWith(10313, { channel: 'sfx', volume: 1 }, 'event:actor_died');
  });
});

describe('useAudioManager tick metronome', () => {
  const settings = {
    areaVolume: 0.1,
    masterVolume: 0.1,
    sfxVolume: 0.1,
    muteWhenUnfocused: false,
    tickAudioMetronomeEnabled: true,
    tickAudioMetronomeTock: false,
    tickAudioMetronomeVolume: 0.3,
  };

  function mountMetronome() {
    const setVolume = vi.spyOn(AudioEngine.prototype, 'setMetronomeVolume');
    const playBeat = vi.spyOn(AudioEngine.prototype, 'playMetronomeBeat').mockImplementation(() => {});
    const hook = renderHook((props) => useAudioManager(props), { initialProps: settings });
    activeAudio = hook.result.current;
    return { ...hook, setVolume, playBeat };
  }

  it('plays the same tick every tick when tock is off', () => {
    const { playBeat } = mountMetronome();

    tickBus.publish(8, []);
    tickBus.publish(9, []);

    expect(playBeat.mock.calls).toEqual([['tick'], ['tick']]);
  });

  it('alternates tick and tock by absolute engine tick when tock is on', () => {
    const { playBeat, rerender } = mountMetronome();
    rerender({ ...settings, tickAudioMetronomeTock: true });

    tickBus.publish(8, []);
    tickBus.publish(9, []);

    expect(playBeat.mock.calls).toEqual([['tick'], ['tock']]);
  });

  it('stops beating when disabled and applies its own volume', () => {
    const { playBeat, setVolume, rerender } = mountMetronome();
    expect(setVolume).toHaveBeenLastCalledWith(0.3);

    rerender({ ...settings, tickAudioMetronomeEnabled: false });
    tickBus.publish(10, []);

    expect(playBeat).not.toHaveBeenCalled();
  });
});

describe('useEventAudioScope', () => {
  const settings = {
    areaVolume: 1,
    masterVolume: 1,
    sfxVolume: 1,
    muteWhenUnfocused: false,
    tickAudioMetronomeEnabled: false,
    tickAudioMetronomeTock: false,
    tickAudioMetronomeVolume: 1,
  };
  // An Inferno spark landing on [25, 25] at tick 2, its sound 3 cycles later (due at 1260 ms), as a
  // loaded recording delivers it: in today's shape.
  const spark = decodeLegacyReplayFrames([{ events: [LEGACY_INFERNO_EVENTS.barrage] }])[0].events[0];

  type DisplayedScene = { kind: string; sceneLoadId: number };

  function mountScoped(kind: string, sceneLoadId = 1) {
    const hook = renderHook(
      (scene: DisplayedScene) => {
        const audio = useAudioManager(settings);
        useEventAudioScope(audio.eventAudioPlayerRef, audio.audioEngine, scene.kind, scene.sceneLoadId);
        return audio;
      },
      { initialProps: { kind, sceneLoadId } },
    );
    activeAudio = hook.result.current;
    const play = vi.spyOn(activeAudio.audioEngine, 'play').mockImplementation(() => {});
    return { ...hook, play, player: activeAudio.eventAudioPlayerRef.current };
  }

  it("dispatches the displayed encounter's rules and follows the displayed kind", () => {
    const { play, player, rerender } = mountScoped('lobby');
    player.onEvents([spark], [25, 25]);
    expect(play).not.toHaveBeenCalled();

    rerender({ kind: 'inferno', sceneLoadId: 2 });
    player.onEvents([spark], [25, 25]);

    expect(play.mock.calls.map(([id]) => id)).toEqual([156]);
  });

  it("drops the old scene's queued replay sounds when the displayed encounter changes", () => {
    const { play, player, rerender } = mountScoped('inferno');
    player.updateReplayClock(1200);
    player.onEvents([spark], [25, 25]);

    rerender({ kind: 'lobby', sceneLoadId: 1 });
    player.updateReplayClock(1300);

    expect(play).not.toHaveBeenCalled();
  });

  it('keeps queued replay sounds while the displayed scene stays the same', () => {
    const { play, player, rerender } = mountScoped('inferno');
    player.updateReplayClock(1200);
    player.onEvents([spark], [25, 25]);

    rerender({ kind: 'inferno', sceneLoadId: 1 });
    player.updateReplayClock(1300);

    expect(play.mock.calls.map(([id]) => id)).toEqual([156]);
  });

  /**
   * Live sounds go straight to the engine, natively delayed, so only the engine can cancel them. Uses
   * its own engine on a fake Web Audio context, leaving the app's shared engine without one.
   */
  describe('live sounds the engine already owns', () => {
    const buffer = { duration: 1, length: 1, numberOfChannels: 1 } as AudioBuffer;
    let sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>;
    let engine: AudioEngine;

    beforeEach(() => {
      sources = [];
      const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      const context = {
        currentTime: 10,
        state: 'running',
        destination: {},
        createGain: () => ({ ...node(), gain: { value: 1 } }),
        createBufferSource: () => {
          const source = { ...node(), buffer: null, onended: null, start: vi.fn(), stop: vi.fn() };
          sources.push(source);
          return source;
        },
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.stubGlobal('AudioContext', function FakeAudioContext() {
        return context;
      });
      engine = new AudioEngine(undefined, async () => buffer);
    });

    afterEach(() => {
      engine.dispose();
      vi.unstubAllGlobals();
    });

    function mountLiveScope(kind: string, sceneLoadId: number) {
      const playerRef = { current: createEventAudioPlayer(engine) };
      return {
        ...renderHook((scene: DisplayedScene) => useEventAudioScope(playerRef, engine, scene.kind, scene.sceneLoadId), {
          initialProps: { kind, sceneLoadId },
        }),
        player: playerRef.current,
      };
    }

    it('stops a delayed live sound before its onset when a new load replaces the scene, not on rerender', async () => {
      await engine.preloadSounds([156]);
      const { player, rerender } = mountLiveScope('inferno', 1);
      player.onEvents([spark], [25, 25]);
      expect(sources).toHaveLength(1);
      const [scheduled] = sources;
      expect(scheduled.start).toHaveBeenCalledExactlyOnceWith(10.06, 0);

      rerender({ kind: 'inferno', sceneLoadId: 1 });
      expect(scheduled.stop).not.toHaveBeenCalled();

      rerender({ kind: 'inferno', sceneLoadId: 2 });
      expect(scheduled.stop).toHaveBeenCalledOnce();
    });

    it("keeps a finished replay's tail sounds, which end no scene", async () => {
      await engine.preloadSounds([156]);
      const { player, rerender } = mountLiveScope('inferno', 1);
      player.updateReplayClock(1200);
      player.onEvents([spark], [25, 25]);

      player.finishReplay(1);
      rerender({ kind: 'inferno', sceneLoadId: 1 });

      expect(sources).toHaveLength(1);
      expect(sources[0].stop).not.toHaveBeenCalled();
    });

    it('never starts a live sound still loading when the scene is replaced', async () => {
      const { player, rerender } = mountLiveScope('inferno', 1);
      player.onEvents([spark], [25, 25]);

      rerender({ kind: 'lobby', sceneLoadId: 1 });
      await engine.preloadSounds([156]);

      expect(sources).toHaveLength(0);
    });
  });
});
