import { DUKE_KIND, LEGACY_DUKE_KIND } from '../encounters/catalog';
import { migrateDukeMechanics } from '../types/duke';
import type { PrayerType, SimulationState } from '../types/simulation';
import type { EncounterSnapshot } from './encounters/snapshot';
import type { EngineRunConfig } from './engineRunConfig';

/**
 * The prayer fields of a state recorded while boost prayers had a single offensive slot.
 *
 * Those builds lit at most one of the eight offensive prayers, every one of which conflicts with
 * the others, so the slot is exactly a boost set of zero or one prayers. Its position also matches:
 * `prayerState.activePrayers` was built protection, offensive, independent, as it is built
 * protection, boost, independent now, so a reconstruction compares equal to the converted frame.
 */
interface LegacyOffensiveSlotState {
  readonly offensivePrayer?: PrayerType | null;
  readonly pendingOffensivePrayer?: readonly [boolean, PrayerType | null];
}

function slotAsSet(prayer: PrayerType | null | undefined): PrayerType[] {
  return prayer === null || prayer === undefined ? [] : [prayer];
}

/**
 * A recorded state in today's prayer shape. One already in it is returned as it is; the input is
 * never modified.
 */
export function decodeLegacyPrayerState(state: SimulationState): SimulationState {
  if ('boostPrayers' in state) return state;
  const { offensivePrayer, pendingOffensivePrayer, ...rest } = state as SimulationState & LegacyOffensiveSlotState;
  return {
    ...rest,
    boostPrayers: slotAsSet(offensivePrayer),
    pendingBoostPrayers: [pendingOffensivePrayer?.[0] ?? false, slotAsSet(pendingOffensivePrayer?.[1])],
  };
}

/** Duke recordings used the same snapshot fields under the retired encounter key. */
export function decodeLegacyDukeState(state: SimulationState): SimulationState {
  if ((state.encounter?.kind as string) !== LEGACY_DUKE_KIND) return state;

  const encounter = { ...state.encounter, kind: DUKE_KIND } as Extract<EncounterSnapshot, { kind: typeof DUKE_KIND }>;
  const mechanicsConfig = state.mechanicsConfig ? migrateDukeMechanics(state.mechanicsConfig) : state.mechanicsConfig;
  return { ...state, encounter, mechanicsConfig };
}

export function decodeLegacyDukeRunConfig(config: EngineRunConfig | null): EngineRunConfig | null {
  if (config?.encounter.kind !== LEGACY_DUKE_KIND) return config;

  const { bootstrap } = config;
  const mechanics = bootstrap?.mechanicsConfig;
  return {
    ...config,
    encounter: { ...config.encounter, kind: DUKE_KIND },
    ...(bootstrap && mechanics && typeof mechanics === 'object' && !Array.isArray(mechanics)
      ? { bootstrap: { ...bootstrap, mechanicsConfig: migrateDukeMechanics(mechanics) } }
      : {}),
  };
}
