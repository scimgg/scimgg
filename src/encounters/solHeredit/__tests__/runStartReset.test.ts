import { afterEach, describe, expect, it } from 'vitest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import type { EncounterModifierSelection } from '../../../core/encounters/encounterFactory';
import { isSolHereditSnapshot } from '../../../core/encounters/snapshot';
import type { EngineRunConfig } from '../../../core/engineRunConfig';
import type { SimulationEngine } from '../../../core/SimulationEngine';
import { SOL_ACTOR_ID } from '../../../npcs/colosseum/constants';
import { diffResumableState } from '../../../replay/resumableState';
import { createEmptyCombatSupplies } from '../../../types/encounterLoadout';
import { createEmptyInventory } from '../../../types/inventory';
import { createDefaultStats } from '../../../types/playerState';
import { colosseumRunState } from '../../colosseum/waves/snapshot';
import { createSimulationEngineForNewRun, createSimulationEngineFromRunConfig } from '../../simulationEngineFactory';
import { SOL_PLAYER_START } from '../constants';
import { COLOSSEUM_START_WAVE_KEY } from '../controls';

const originalArena = getArenaConfig();
const originalFallback = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(originalArena, originalFallback));

/** Frailty I: a direct start fights at 90 from tick 0, a wave run only from its start wave's T0. */
const SET: EncounterModifierSelection = { frailty: 1 };

function newRun(startWave: string) {
  return createSimulationEngineForNewRun({
    encounterConfig: {
      kind: 'sol_heredit',
      mechanics: { [COLOSSEUM_START_WAVE_KEY]: startWave },
      options: { modifiers: SET },
    },
    enableIntro: false,
    stats: createDefaultStats(),
    inventory: createEmptyInventory(),
    equipment: {},
    combatSupplies: createEmptyCombatSupplies(),
    attackStylePerCategory: {},
    combatSeed: 0x5eed,
  });
}

function run(engine: SimulationEngine) {
  const snapshot = engine.getEncounterSnapshot();
  if (!isSolHereditSnapshot(snapshot)) throw new TypeError('Not a Sol Heredit run');
  return { run: colosseumRunState(snapshot.state), visuals: snapshot.visuals };
}

/** The engine a fresh run of `config` opens with, and the arena it installs. */
function reference(config: EngineRunConfig) {
  const engine = createSimulationEngineFromRunConfig(config, null);
  if (!engine) throw new TypeError('Expected a rebuilt engine');
  return { engine, arena: getArenaConfig() };
}

/** Both engines walk the same path and stay identical, tick by tick. */
function expectSameRun(expected: SimulationEngine, actual: SimulationEngine, ticks: number): string[] {
  const eventTypes: string[] = [];
  for (let tick = 1; tick <= ticks; tick++) {
    const target = expected.getState().playerPosition;
    expected.advanceTick(target);
    actual.advanceTick(target);
    expect([tick, diffResumableState(expected.getState(), actual.getState())]).toEqual([tick, []]);
    eventTypes.push(...expected.getLastTickEvents().map((event) => event.type));
  }
  return eventTypes;
}

describe('a tick-zero reset with a recorded run across the start stages', () => {
  it('opens a direct Sol start from an unadvanced wave run: one Sol at C = 0, his fence, HP and tile', () => {
    const direct = newRun('12').getRunConfig();
    const { engine: expected, arena: solArena } = reference(direct);
    const engine = newRun('1');
    const waveArena = getArenaConfig();
    expect(engine.getState().npcs).toEqual([]);
    expect(engine.getState().maxHP).toBe(99);
    expect(waveArena).not.toEqual(solArena);

    engine.reset(undefined, direct);

    expect(engine.getState().npcs.map((npc) => npc.id)).toEqual([SOL_ACTOR_ID]);
    expect(run(engine)).toEqual({
      run: expect.objectContaining({ stage: 'sol', solControlTick: 0 }),
      visuals: { solControlTick: 0 },
    });
    expect(engine.getState().playerPosition).toEqual([...SOL_PLAYER_START]);
    expect(engine.getState()).toMatchObject({ maxHP: 90, playerHP: 90 });
    expect(getArenaConfig()).toEqual(solArena);
    expect(diffResumableState(expected.getState(), engine.getState())).toEqual([]);
    // Sol takes his opening turns: the taunt, then his first attack landing.
    expect(expectSameRun(expected, engine, 12)).toEqual(expect.arrayContaining(['overhead_text', 'hit_applied']));
    expect(engine.getState().npcs.filter((npc) => npc.id === SOL_ACTOR_ID)).toHaveLength(1);
  });

  it('opens a wave run from an unadvanced direct start with no Sol', () => {
    const wave = newRun('1').getRunConfig();
    const { engine: expected, arena: waveArena } = reference(wave);
    const engine = newRun('12');
    expect(engine.getState().npcs.map((npc) => npc.id)).toEqual([SOL_ACTOR_ID]);

    engine.reset(undefined, wave);

    expect(engine.getState().npcs).toEqual([]);
    expect(run(engine)).toEqual({
      run: expect.objectContaining({ startWave: 1, stage: 'intermission', solControlTick: null }),
      visuals: { solControlTick: null },
    });
    expect(engine.getState()).toMatchObject({ maxHP: 99, playerHP: 99 });
    expect(getArenaConfig()).toEqual(waveArena);
    expect(diffResumableState(expected.getState(), engine.getState())).toEqual([]);
    expectSameRun(expected, engine, 12);
    expect(engine.getState().npcs.some((npc) => npc.id === SOL_ACTOR_ID)).toBe(false);
  });
});
