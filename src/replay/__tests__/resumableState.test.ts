import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../core/constants';
import type { InfernoSnapshot } from '../../core/encounters/snapshot';
import { SimulationEngine } from '../../core/SimulationEngine';
import { encounterRegistry } from '../../encounters/registry';
import type { Coordinate, SimulationState } from '../../types/simulation';
import { PrayerType } from '../../types/simulation';
import { diffResumableState } from '../resumableState';

function makeEngine(): SimulationEngine {
  return new SimulationEngine({ encounter: encounterRegistry.create('yama_p3'), startPos: [31, 37] });
}

/** Two snapshots of ONE engine: same encounter seeds, so only deliberate edits differ. */
function twoSnapshots(): [SimulationState, SimulationState] {
  const engine = makeEngine();
  return [engine.getState(), engine.getState()];
}

describe('diffResumableState', () => {
  it('reports no difference between two snapshots of the same engine', () => {
    const [expectedState, actual] = twoSnapshots();

    expect(diffResumableState(expectedState, actual)).toEqual([]);
  });

  it('detects a changed player vital', () => {
    const [expectedState, actual] = twoSnapshots();

    expect(diffResumableState(expectedState, { ...actual, playerHP: 42 })).toContain(
      `playerHP: expected ${expectedState.playerHP}, got 42`,
    );
  });

  it('detects a changed tick', () => {
    const [expectedState, actual] = twoSnapshots();

    const diffs = diffResumableState(expectedState, { ...actual, currentTick: 77 });

    expect(diffs.some((d) => d.startsWith('currentTick:'))).toBe(true);
  });

  it('detects a moved player', () => {
    const [expectedState, actual] = twoSnapshots();

    const diffs = diffResumableState(expectedState, { ...actual, playerPosition: [1, 2] as Coordinate });

    expect(diffs.some((d) => d.startsWith('playerPosition'))).toBe(true);
  });

  it('detects a difference nested inside an npc', () => {
    const [expectedState, actual] = twoSnapshots();
    expect(actual.npcs.length).toBeGreaterThan(0);
    const hurtBoss = { ...actual, npcs: actual.npcs.map((npc, i) => (i === 0 ? { ...npc, hp: npc.hp - 1 } : npc)) };

    const diffs = diffResumableState(expectedState, hurtBoss);

    expect(diffs.some((d) => d.startsWith('npcs.0.hp'))).toBe(true);
  });

  it('detects an encounter rebuilt on different seeds', () => {
    // Given: reconstructing with the wrong seeds replays a different fight, which is the whole
    // failure takeover exists to prevent — so it must not slip past the gate.
    const fromOneEngine = makeEngine().getState();
    const fromAnother = makeEngine().getState();

    const diffs = diffResumableState(fromOneEngine, fromAnother);

    expect(diffs.some((d) => d.startsWith('encounter.'))).toBe(true);
  });

  it('ignores the append-only event log', () => {
    // Given: the log grows for the whole run and is never read back into the simulation, so
    // comparing it would abort every takeover.
    const [expectedState, actual] = twoSnapshots();
    const noisy = { ...actual, eventLog: [...actual.eventLog, { tick: 999, type: 'TICK_START' } as never] };

    expect(diffResumableState(expectedState, noisy)).toEqual([]);
  });

  it('ignores position history, which a recorded frame always has empty', () => {
    // Given: the recorder empties these before storing a frame, while a live engine keeps them.
    const [expectedState, actual] = twoSnapshots();
    const withTrail: SimulationState = {
      ...actual,
      playerHistory: new Map([[5, [10, 10] as Coordinate]]),
      primaryNpcHistory: new Map([[5, [11, 11] as Coordinate]]),
    };

    expect(diffResumableState(expectedState, withTrail)).toEqual([]);
  });

  it('accepts a Duke recording without orb interpolation history and still compares its true tile', () => {
    const encounter: SimulationState['encounter'] = {
      kind: 'duke_practice',
      state: { bileTicksRemaining: 0, enraged: false, perfectKillEligible: true },
      visuals: { hazards: [], orbTile: [35, 51] },
    };
    const recorded: SimulationState = { ...makeEngine().getState(), encounter };
    const rebuilt: SimulationState = {
      ...recorded,
      encounter: { ...encounter, visuals: { ...encounter.visuals, orbPreviousTile: [36, 51] } },
    };

    expect(diffResumableState(recorded, rebuilt)).toEqual([]);
    expect(
      diffResumableState(recorded, {
        ...rebuilt,
        encounter: { ...encounter, visuals: { ...encounter.visuals, orbTile: [34, 51] } },
      }),
    ).toContain('encounter.visuals.orbTile.0: expected 35, got 34');
  });

  it('ignores crawl presentation history but not the fight state', () => {
    const [recorded, rebuilt] = twoSnapshots();
    const withCrawl: SimulationState = {
      ...rebuilt,
      npcs: rebuilt.npcs.map((npc) => ({
        ...npc,
        crawlMovement: { from: [npc.position[0] - 1, npc.position[1]], to: npc.position, startTick: 0 },
      })),
    };

    expect(diffResumableState(recorded, withCrawl)).toEqual([]);
    expect(diffResumableState(withCrawl, recorded)).toEqual([]);
    const shiftedHistory: SimulationState = {
      ...withCrawl,
      npcs: withCrawl.npcs.map((npc) => ({ ...npc, crawlMovement: { ...npc.crawlMovement!, startTick: 1 } })),
    };
    expect(diffResumableState(withCrawl, shiftedHistory)).toEqual([]);

    const diverged: SimulationState = {
      ...withCrawl,
      npcs: withCrawl.npcs.map((npc, index) =>
        index === 0 ? { ...npc, position: [npc.position[0] + 1, npc.position[1]], hp: npc.hp - 1 } : npc,
      ),
      playerHP: withCrawl.playerHP - 1,
      damageHistory: [
        {
          tick: 0,
          source: 'test',
          targetId: 'player',
          baseDamage: 1,
          attackType: 'typeless',
          activePrayer: null,
          prayedCorrectly: null,
          effectiveDamage: 1,
          hpBefore: withCrawl.playerHP,
          hpAfter: withCrawl.playerHP - 1,
        },
      ],
    };
    const differences = diffResumableState(recorded, diverged);
    expect(differences.some((diff) => diff.startsWith('npcs.0.position'))).toBe(true);
    expect(differences.some((diff) => diff.startsWith('npcs.0.hp'))).toBe(true);
    expect(differences.some((diff) => diff.startsWith('playerHP'))).toBe(true);
    expect(differences.some((diff) => diff.startsWith('damageHistory'))).toBe(true);
  });

  it('caps how many differences it reports so a wholly different state stays loggable', () => {
    const [expectedState, actual] = twoSnapshots();
    const wrong: SimulationState = { ...actual, playerHP: 1, currentTick: 50, playerPosition: [0, 0] as Coordinate };

    const diffs = diffResumableState(expectedState, wrong);

    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.length).toBeLessThanOrEqual(12);
  });

  it('detects a pending independent-prayer difference', () => {
    const [expectedState, actual] = twoSnapshots();

    const diffs = diffResumableState(expectedState, {
      ...actual,
      pendingIndependentPrayers: [true, [PrayerType.Preserve]],
    });

    expect(diffs.some((d) => d.startsWith('pendingIndependentPrayers'))).toBe(true);
  });

  it('detects a Preserve stat-decay extension the other side never earned', () => {
    const [expectedState, actual] = twoSnapshots();
    const extended: SimulationState = {
      ...expectedState,
      combatTimers: { ...expectedState.combatTimers, statBoostDecayExtended: true },
    };

    const diffs = diffResumableState(extended, actual);

    expect(diffs.some((d) => d.includes('statBoostDecayExtended'))).toBe(true);
  });

  it('detects a recovery cycle or a decay lock the other side does not have', () => {
    const [expectedState, actual] = twoSnapshots();
    const diverged: SimulationState = {
      ...expectedState,
      combatTimers: {
        ...expectedState.combatTimers,
        statRecoveryTick: expectedState.combatTimers.statRecoveryTick + 1,
        statDecayLocks: { attack: { ticksRemaining: 12, source: 'divine' } },
      },
    };

    const diffs = diffResumableState(diverged, actual);

    expect(diffs.some((d) => d.includes('statRecoveryTick'))).toBe(true);
    expect(diffs.some((d) => d.includes('statDecayLocks.attack'))).toBe(true);
  });

  describe('Inferno run-setup metadata', () => {
    let arena: ReturnType<typeof getArenaConfig>;
    let allowUnbounded: boolean;
    beforeEach(() => {
      arena = getArenaConfig();
      allowUnbounded = getArenaAllowUnboundedFallback();
    });
    afterEach(() => setArenaConfig(arena, allowUnbounded));

    /** Two snapshots of one Inferno engine on wave 30, a wave spawned (so every field is set). */
    function infernoSnapshots(): [SimulationState, SimulationState] {
      const engine = new SimulationEngine({
        encounter: encounterRegistry.create('inferno'),
        mechanics: { infernoStartWave: '30' },
      });
      engine.advanceTick(engine.getState().playerPosition);
      engine.advanceTick(engine.getState().playerPosition);
      return [engine.getState(), engine.getState()];
    }

    function inferno(state: SimulationState): InfernoSnapshot {
      if (state.encounter.kind !== 'inferno') throw new Error('expected an Inferno state');
      return state.encounter;
    }

    function withMetadata(state: SimulationState, metadata: Partial<InfernoSnapshot['state']>): SimulationState {
      return { ...state, encounter: { ...inferno(state), state: { ...inferno(state).state, ...metadata } } };
    }

    it('compares the start tile, spawn layout and their mechanics keys', () => {
      const [recorded, rebuilt] = infernoSnapshots();
      expect(inferno(rebuilt).state.startPlayerTile).toBe('34,44');
      expect(inferno(rebuilt).state.waveSpawnLayout).not.toBe('');
      expect(inferno(rebuilt).state.waveStartPlayerTile).not.toBeNull();
      expect(rebuilt.mechanicsConfig).toMatchObject({ infernoSpawnLayout: '', infernoStartTile: '' });
      expect(diffResumableState(recorded, rebuilt)).toEqual([]);

      const { startPlayerTile, waveStartPlayerTile } = inferno(recorded).state;
      const moved = withMetadata(rebuilt, { startPlayerTile: '25,39', waveStartPlayerTile: [25, 39] });
      expect(diffResumableState(recorded, moved)).toEqual([
        `encounter.state.startPlayerTile: expected "${startPlayerTile}", got "25,39"`,
        `encounter.state.waveStartPlayerTile.0: expected ${waveStartPlayerTile?.[0]}, got 25`,
        `encounter.state.waveStartPlayerTile.1: expected ${waveStartPlayerTile?.[1]}, got 39`,
      ]);

      const custom = {
        ...rebuilt,
        mechanicsConfig: { ...rebuilt.mechanicsConfig, infernoSpawnLayout: '30:b--------', infernoStartTile: '25,39' },
      };
      expect(diffResumableState(recorded, custom)).toEqual([
        'mechanicsConfig.infernoSpawnLayout: expected "", got "30:b--------"',
        'mechanicsConfig.infernoStartTile: expected "", got "25,39"',
      ]);
    });
  });
});
