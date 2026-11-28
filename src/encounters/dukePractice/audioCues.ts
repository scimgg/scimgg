import type { TickEvents } from '../../core/events/TickEvents';
import type { Coordinate } from '../../types/simulation';

export const DUKE_PRACTICE_AUDIO_EVENT = 'duke_practice_audio';

export type DukePracticeAudioCue =
  | 'feed'
  | 'wake'
  | 'slamWindup'
  | 'spikes'
  | 'slam'
  | 'gazeWindup'
  | 'gaze'
  | 'magicLaunch'
  | 'magicFastLaunch'
  | 'magic'
  | 'ventLaunch'
  | 'vent'
  | 'ventIdle'
  | 'gasSpitLaunch'
  | 'gasSpit'
  | 'bile'
  | 'orbSpawn'
  | 'orbHit'
  | 'dukeHit'
  | 'defeat';

export function emitDukePracticeAudio(tickEvents: TickEvents, cue: DukePracticeAudioCue, position?: Coordinate): void {
  tickEvents.emit({ type: DUKE_PRACTICE_AUDIO_EVENT, cue, ...(position ? { position } : {}) });
}
