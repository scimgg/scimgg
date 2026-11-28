import type { MechanicsConfig } from './simulation';

export const DUKE_START_PHASE_KEY = 'dukeStartPhase';
export const DUKE_ALWAYS_BILE_KEY = 'dukeAlwaysBile';
export const DUKE_AUDIO_EVENT = 'duke_audio';

/** Renames phase and bile settings from saved runs or preferences. */
export function migrateDukeMechanics(config: MechanicsConfig): MechanicsConfig;
export function migrateDukeMechanics(config: Partial<MechanicsConfig>): Partial<MechanicsConfig>;
export function migrateDukeMechanics(config: Partial<MechanicsConfig>): Partial<MechanicsConfig> {
  if (!('dukePracticeStartPhase' in config || 'dukePracticeAlwaysBile' in config)) return config;

  const { dukePracticeStartPhase: phase, dukePracticeAlwaysBile: alwaysBile, ...current } = config;
  if (current[DUKE_START_PHASE_KEY] === undefined && typeof phase === 'string') current[DUKE_START_PHASE_KEY] = phase;
  if (current[DUKE_ALWAYS_BILE_KEY] === undefined && typeof alwaysBile === 'boolean')
    current[DUKE_ALWAYS_BILE_KEY] = alwaysBile;
  return current;
}
