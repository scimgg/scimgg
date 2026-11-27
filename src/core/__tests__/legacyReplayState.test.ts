import { describe, expect, it } from 'vitest';
import { LobbyEncounter } from '../../encounters/lobby/LobbyEncounter';
import { diffResumableState } from '../../replay/resumableState';
import { PrayerType, type SimulationState } from '../../types/simulation';
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
      runConfig: null,
      capture: recorder.exportData().capture,
    });

    const state = recorder.getFrame(0)?.state;
    expect(state?.boostPrayers).toEqual([PrayerType.Piety]);
    expect(state).not.toHaveProperty('offensivePrayer');
    expect(recorder.exportData().frames[0]?.state).not.toHaveProperty('offensivePrayer');
  });
});
