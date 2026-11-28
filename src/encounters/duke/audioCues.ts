import type { TickEvents } from '../../core/events/TickEvents';
import { DUKE_AUDIO_EVENT } from '../../types/duke';
import type { Coordinate } from '../../types/simulation';

export type DukeAudioCue =
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

export function emitDukeAudio(tickEvents: TickEvents, cue: DukeAudioCue, position?: Coordinate): void {
  tickEvents.emit({ type: DUKE_AUDIO_EVENT, cue, ...(position ? { position } : {}) });
}
