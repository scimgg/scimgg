import { afterEach, describe, expect, it } from 'vitest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import type { MechanicsToggleContext } from '../../../core/encounters/types';
import {
  advanceTo,
  clearWave,
  confirmAndStart,
  type Run,
  runState,
  startRun,
} from '../../colosseum/waves/__tests__/waveRunHarness';
import { SOL_HEREDIT_DEBUG_ACTIONS } from '../commands';
import { buildSolHereditControls, COLOSSEUM_START_WAVE_KEY } from '../controls';

const originalArena = getArenaConfig();
const originalFallback = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(originalArena, originalFallback));

describe("Sol's practice actions", () => {
  const { debugActions } = buildSolHereditControls();
  const visible = (context: MechanicsToggleContext) =>
    debugActions.filter((action) => action.visibleInPractice?.(context) !== false).map(({ label }) => label);
  const all = SOL_HEREDIT_DEBUG_ACTIONS.map(({ label }) => label);
  const during = (run: Run): MechanicsToggleContext => ({
    config: run.engine.getMechanicsConfig(),
    encounterSnapshot: run.engine.getEncounterSnapshot(),
  });

  it('keeps every action, with its command, for a direct Sol start, before and during the fight', () => {
    expect(debugActions.map(({ command, label }) => ({ command, label }))).toEqual(SOL_HEREDIT_DEBUG_ACTIONS);
    expect(visible({ config: {} })).toEqual(all);
    expect(visible({ config: { [COLOSSEUM_START_WAVE_KEY]: '12' } })).toEqual(all);
    expect(visible(during(startRun(12)))).toEqual(all);
    // A recording from before wave runs has no control tick: a direct start.
    expect(
      visible({ config: {}, encounterSnapshot: { kind: 'sol_heredit', state: {} as never, visuals: {} } }),
    ).toEqual(all);
  });

  it('hides them through waves 1-11 and the jump, and offers them from Sol control', () => {
    expect(visible({ config: { [COLOSSEUM_START_WAVE_KEY]: '4' } })).toEqual([]);
    const run = startRun(11, 5);
    expect(visible(during(run))).toEqual([]);
    confirmAndStart(run);
    expect(visible(during(run))).toEqual([]);
    clearWave(run);
    confirmAndStart(run);
    const control = runState(run).solControlTick!;
    advanceTo(run, control - 1);
    expect(runState(run).stage).toBe('sol');
    expect(visible(during(run))).toEqual([]);
    advanceTo(run, control);
    expect(visible(during(run))).toEqual(all);
  });
});
