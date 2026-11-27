import { type MutableRefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { AudioEngine, coreAudioRules, EventAudioPlayer, FrameSoundTracker } from '../audio';
import { cacheSoundBufferLoader, type SoundEffectCache } from '../audio/cacheSoundBuffers';
import type { SoundRules } from '../audio/EventAudioPlayer';
import { encounterAudioRules, encounterPresentationModuleForKind } from '../encounters/presentationModules';
import { tickBus } from '../tutorial/runtime/tickBus';
import { getPageActivity, subscribePageActivity } from './pageActivity';

/**
 * The app's event-audio player: every encounter's rules in manifest order, then the engine's own core
 * rules, so preloading covers every sound. Which of them dispatch is the displayed encounter's choice
 * ({@link eventAudioRulesFor}).
 */
export function createEventAudioPlayer(engine: AudioEngine): EventAudioPlayer {
  return new EventAudioPlayer(engine, ...encounterAudioRules(), coreAudioRules);
}

/**
 * The rules that dispatch while `encounterKind` is displayed: its presentation module's (a variant
 * kind resolves to its parent's), then core, so an encounter's rule overrides a core one. Another
 * encounter's rules never answer its events: a rule that answers `silent` for an event it does not
 * recognize would otherwise swallow the sound.
 */
export function eventAudioRulesFor(encounterKind: string): readonly SoundRules[] {
  const rules = encounterPresentationModuleForKind(encounterKind)?.audioRules;
  return rules === undefined ? [coreAudioRules] : [rules, coreAudioRules];
}

/**
 * Scopes event audio to the displayed scene, identified as Grid identifies it: the kind that chooses
 * its scene builder plus its load id, which a fresh entry into the same kind also advances. Applied
 * before paint, so no frame of the new scene dispatches through the old scope.
 *
 * Replacing the scene silences the old one: its queued replay sounds and every voice the engine already
 * owns, including delayed live sounds and ones still loading. A pause stays with whoever owns it.
 *
 * Separate from {@link useAudioManager} because the player must exist before the cache bootstrap, which
 * comes before the encounter state that names the displayed scene.
 */
export function useEventAudioScope(
  eventAudioPlayerRef: MutableRefObject<EventAudioPlayer>,
  audioEngine: AudioEngine,
  displayedEncounterKind: string,
  sceneLoadId: number,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: sceneLoadId is half of the scene's identity; a new load replaces the scene.
  useLayoutEffect(() => {
    const player = eventAudioPlayerRef.current;
    player.setDispatchRules(eventAudioRulesFor(displayedEncounterKind));
    return () => {
      player.reset();
      audioEngine.discardSounds();
    };
  }, [eventAudioPlayerRef, audioEngine, displayedEncounterKind, sceneLoadId]);
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
