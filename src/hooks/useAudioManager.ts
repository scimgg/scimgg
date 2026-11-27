import { type MutableRefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { AudioEngine, coreAudioRules, EventAudioPlayer, FrameSoundTracker } from '../audio';
import { cacheSoundBufferLoader, type SoundEffectCache } from '../audio/cacheSoundBuffers';
import type { SoundRuleLayer } from '../audio/EventAudioPlayer';
import { encounterAudioLayers, encounterPresentationModuleForKind } from '../encounters/presentationModules';
import { tickBus } from '../tutorial/runtime/tickBus';
import { getPageActivity, subscribePageActivity } from './pageActivity';

/** The engine's own rules, which answer in every encounter. */
const CORE_AUDIO_LAYER: SoundRuleLayer = { name: 'core', rules: coreAudioRules };

/**
 * The app's event-audio player: every encounter's layer in manifest order, then core last, so an
 * encounter's rule overrides a core one. All are installed so preloading covers every sound; which of
 * them dispatch is the displayed encounter's choice ({@link eventAudioLayersFor}).
 */
export function createEventAudioPlayer(engine: AudioEngine): EventAudioPlayer {
  return new EventAudioPlayer(engine, ...encounterAudioLayers(), CORE_AUDIO_LAYER);
}

/**
 * The layers that dispatch while `encounterKind` is displayed: its presentation module's (a variant
 * kind resolves to its parent's), then core. Another encounter's rules never answer its events: a
 * rule that answers `silent` for an event it does not recognize would otherwise swallow the sound.
 */
export function eventAudioLayersFor(encounterKind: string): string[] {
  const layer = encounterPresentationModuleForKind(encounterKind)?.audio?.layerName;
  return layer === undefined ? [CORE_AUDIO_LAYER.name] : [layer, CORE_AUDIO_LAYER.name];
}

/**
 * Scopes the event-audio player to the displayed encounter. Pass the kind that chooses the displayed
 * scene builder, so the scene and its sounds always agree. Applied before paint, so no frame of the new
 * scene dispatches through the old scope; a scene change also drops the old scene's queued replay sounds.
 *
 * Separate from {@link useAudioManager} because the player must exist before the cache bootstrap, which
 * comes before the encounter state that names the displayed kind.
 */
export function useEventAudioScope(
  eventAudioPlayerRef: MutableRefObject<EventAudioPlayer>,
  displayedEncounterKind: string,
): void {
  useLayoutEffect(() => {
    const player = eventAudioPlayerRef.current;
    player.setDispatchLayers(eventAudioLayersFor(displayedEncounterKind));
    return () => player.reset();
  }, [eventAudioPlayerRef, displayedEncounterKind]);
}

let audioEngineSingleton: AudioEngine | null = null;

/**
 * The app's one engine, created by the first `useAudioManager` call. Its sounds render from that
 * call's cache, which is fixed for the page's lifetime (App passes its `CacheManager` singleton).
 * Without a cache every sound is unavailable, as tests that need no audio expect.
 */
function sharedAudioEngine(soundEffectCache: SoundEffectCache | undefined): AudioEngine {
  audioEngineSingleton ??= new AudioEngine(
    undefined,
    soundEffectCache ? cacheSoundBufferLoader(soundEffectCache) : undefined,
  );
  return audioEngineSingleton;
}

interface UseAudioManagerParams {
  areaVolume: number;
  masterVolume: number;
  sfxVolume: number;
  muteWhenUnfocused: boolean;
  tickAudioMetronomeEnabled: boolean;
  tickAudioMetronomeTock: boolean;
  tickAudioMetronomeVolume: number;
  /** Where game sounds render from; see `sharedAudioEngine`. */
  soundEffectCache?: SoundEffectCache;
}

export interface UseAudioManagerReturn {
  audioEngine: AudioEngine;
  eventAudioPlayerRef: MutableRefObject<EventAudioPlayer>;
  frameSoundTrackerRef: MutableRefObject<FrameSoundTracker>;
}

export function useAudioManager({
  areaVolume,
  masterVolume,
  sfxVolume,
  muteWhenUnfocused,
  tickAudioMetronomeEnabled,
  tickAudioMetronomeTock,
  tickAudioMetronomeVolume,
  soundEffectCache,
}: UseAudioManagerParams): UseAudioManagerReturn {
  const audioEngine = sharedAudioEngine(soundEffectCache);
  const eventAudioPlayerRef = useRef(createEventAudioPlayer(audioEngine));
  const frameSoundTrackerRef = useRef(new FrameSoundTracker(audioEngine));

  useEffect(() => {
    const handleUserGesture = () => {
      void audioEngine.resume();
    };

    window.addEventListener('click', handleUserGesture, { once: true });
    window.addEventListener('keydown', handleUserGesture, { once: true });

    return () => {
      window.removeEventListener('click', handleUserGesture);
      window.removeEventListener('keydown', handleUserGesture);
    };
  }, [audioEngine]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }

    if (!muteWhenUnfocused) {
      audioEngine.setFocusSuspended(false);
      return;
    }

    const updateFocusState = () => {
      // The same notion of "in the background" that pauses the simulator (see pageActivity).
      const suspended = document.hidden || getPageActivity() !== 'focused';
      audioEngine.setFocusSuspended(suspended);
      if (suspended) eventAudioPlayerRef.current.reset();
    };

    updateFocusState();
    const unsubscribe = subscribePageActivity(updateFocusState);

    return () => {
      unsubscribe();
      // Ensure we never leave the engine stuck in suspended state if the
      // component unmounts while unfocused or the feature is toggled off.
      audioEngine.setFocusSuspended(false);
    };
  }, [audioEngine, muteWhenUnfocused]);

  useEffect(() => {
    audioEngine.setMasterVolume(masterVolume);
    if (masterVolume <= 0) eventAudioPlayerRef.current.reset();
  }, [audioEngine, masterVolume]);

  useEffect(() => {
    audioEngine.setSfxVolume(sfxVolume);
  }, [audioEngine, sfxVolume]);

  useEffect(() => {
    audioEngine.setAreaVolume(areaVolume);
  }, [audioEngine, areaVolume]);

  useEffect(() => {
    audioEngine.setMetronomeVolume(tickAudioMetronomeVolume);
  }, [audioEngine, tickAudioMetronomeVolume]);

  useEffect(() => {
    if (!tickAudioMetronomeEnabled) return;
    // Alternate by absolute tick so the tick/tock phase is stable across pauses.
    return tickBus.subscribe((tick) =>
      audioEngine.playMetronomeBeat(tickAudioMetronomeTock && tick % 2 === 1 ? 'tock' : 'tick'),
    );
  }, [audioEngine, tickAudioMetronomeEnabled, tickAudioMetronomeTock]);

  return {
    audioEngine,
    eventAudioPlayerRef,
    frameSoundTrackerRef,
  };
}
