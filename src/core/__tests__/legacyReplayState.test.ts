import { describe, expect, it } from 'vitest';
import { LobbyEncounter } from '../../encounters/lobby/LobbyEncounter';
import {
  createSimulationEngineForNewRun,
  createSimulationEngineFromRunConfig,
} from '../../encounters/simulationEngineFactory';
import { diffResumableState } from '../../replay/resumableState';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import { createEmptyInventory } from '../../types/inventory';
import { createDefaultStats } from '../../types/playerState';
import { PrayerType, type SimulationState } from '../../types/simulation';
import { ENGINE_RUN_BOOTSTRAP_VERSION, type EngineRunConfig, resolveRunBootstrap } from '../engineRunConfig';
import { decodeLegacyPrayerState } from '../legacyReplayState';
import { DEFAULT_REPLAY_UI_STATE, ReplayRecorder } from '../ReplayRecorder';
import { SimulationEngine } from '../SimulationEngine';

/** A state as builds with the single offensive slot recorded it, written out by hand. */
function asSlotRecording(
  state: SimulationState,
  offensivePrayer: PrayerType | null,
  pendingOffensivePrayer: [boolean, PrayerType | null],
): SimulationState {
  const { boostPrayers: _boost, pendingBoostPrayers: _pending, ...rest } = state;
  return { ...rest, offensivePrayer, pendingOffensivePrayer } as unknown as SimulationState;
}

function engineWithPietyAndPreserve(): SimulationEngine {
  const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
  engine.queueIndependentPrayer(PrayerType.Preserve);
  engine.queueProtectionPrayer(PrayerType.ProtectMelee);
  engine.queueBoostPrayer(PrayerType.Piety);
  engine.advanceTick(engine.getState().playerPosition);
  return engine;
}

/** A one-frame recording of `live` as the single-slot builds wrote it, with Piety in the slot. */
function loadSlotRecording(live: SimulationState, runConfig: EngineRunConfig | null): ReplayRecorder {
  const recorder = new ReplayRecorder();
  recorder.load({
    frames: [
      {
        tick: live.currentTick,
        input: [...live.playerPosition],
        state: asSlotRecording(live, PrayerType.Piety, [false, PrayerType.Piety]),
        uiState: DEFAULT_REPLAY_UI_STATE,
        events: [],
        actions: [{ type: 'offensivePrayer', prayer: PrayerType.Piety }],
        damageHistoryLength: 0,
      },
    ],
    cursorSamples: [],
    cursorClicks: [],
    presentationSamples: [],
    viewportSamples: [],
    modifierSamples: [],
    damageHistory: [],
    runConfig,
    capture: recorder.exportData().capture,
  });
  return recorder;
}

describe('decodeLegacyPrayerState', () => {
  it('reads a lit offensive slot as a boost set of that one prayer', () => {
    const live = engineWithPietyAndPreserve().getState();
    const decoded = decodeLegacyPrayerState(asSlotRecording(live, PrayerType.Piety, [false, PrayerType.Piety]));

    expect(decoded.boostPrayers).toEqual([PrayerType.Piety]);
    // With nothing queued the prediction is the committed slot, as it was recorded.
    expect(decoded.pendingBoostPrayers).toEqual([false, [PrayerType.Piety]]);
    expect(decoded).not.toHaveProperty('offensivePrayer');
    expect(decoded).not.toHaveProperty('pendingOffensivePrayer');
  });

  it('compares equal to the live state it recorded, so takeover can resume from it', () => {
    const live = engineWithPietyAndPreserve().getState();
    const decoded = decodeLegacyPrayerState(asSlotRecording(live, PrayerType.Piety, [false, PrayerType.Piety]));

    expect(diffResumableState(decoded, live)).toEqual([]);
  });

  it('reads an empty slot and a pending slot prediction', () => {
    const live = new SimulationEngine({ encounter: new LobbyEncounter() }).getState();
    const decoded = decodeLegacyPrayerState(asSlotRecording(live, null, [true, PrayerType.Rigour]));

    expect(decoded.boostPrayers).toEqual([]);
    expect(decoded.pendingBoostPrayers).toEqual([true, [PrayerType.Rigour]]);
  });

  it('returns a state already in the current shape as it is', () => {
    const live = engineWithPietyAndPreserve().getState();
    expect(decodeLegacyPrayerState(live)).toBe(live);
  });

  it('is applied to every frame a recording loads with', () => {
    const live = engineWithPietyAndPreserve().getState();
    const recorder = loadSlotRecording(live, null);

    const state = recorder.getFrame(0)?.state;
    expect(state?.boostPrayers).toEqual([PrayerType.Piety]);
    expect(state).not.toHaveProperty('offensivePrayer');
    expect(recorder.exportData().frames[0]?.state).not.toHaveProperty('offensivePrayer');
  });

  // Version 14 is the last bootstrap before prayer-level and magic-damage rounding changed, which is
  // every recording made with the single offensive slot.
  it('plays a version-14 recording back through the decoder without offering takeover', () => {
    const engine = createSimulationEngineForNewRun({
      encounterConfig: { kind: 'yama_p3', mechanics: { infiniteHealth: true } },
      enableIntro: false,
      stats: createDefaultStats(),
      inventory: createEmptyInventory(),
      equipment: {},
      combatSupplies: createEmptyCombatSupplies(),
      attackStylePerCategory: {},
      combatSeed: 0x1234abcd,
    });
    engine.queueBoostPrayer(PrayerType.Piety);
    engine.advanceTick(engine.getState().playerPosition);
    const current = engine.getRunConfig();
    if (current.bootstrap === undefined) throw new TypeError('Expected a bootstrap');
    const version14: EngineRunConfig = { ...current, bootstrap: { ...current.bootstrap, version: 14 } };

    const recorder = loadSlotRecording(engine.getState(), version14);

    expect(recorder.getFrame(0)?.state.boostPrayers).toEqual([PrayerType.Piety]);
    expect(resolveRunBootstrap(recorder.exportData().runConfig)).toBeNull();
    expect(createSimulationEngineFromRunConfig(version14, null)).toBeNull();
    // The same run under this engine's version rebuilds.
    expect(ENGINE_RUN_BOOTSTRAP_VERSION).toBe(15);
    expect(createSimulationEngineFromRunConfig(current, null)?.getState().currentTick).toBe(0);
  });
});
