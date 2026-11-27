import { describe, expect, it } from 'vitest';
import type { Encounter } from '../../../core/encounters/types';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { createUnusedPlayerControlOps } from '../../../test/helpers/playerControlStubs';
import { LobbyEncounter } from '../LobbyEncounter';

describe('LobbyEncounter', () => {
  describe('interface methods', () => {
    const encounter = new LobbyEncounter();

    it('getDefaultPlayerStart returns lobby start position', () => {
      expect(encounter.getDefaultPlayerStart()).toEqual([31, 25]);
    });

    it('getIntroConfig returns teleport animation config', () => {
      const config = encounter.getIntroConfig();
      expect(config).not.toBeNull();
      expect(config!.facingAngle).toBe(1024);
      expect(config!.animationSeqId).toBe(12152);
    });

    it('kind is lobby', () => {
      expect(encounter.kind).toBe('lobby');
    });
  });

  it('creates no NPCs', () => {
    const encounter = new LobbyEncounter();

    expect(encounter.createNpcs([31, 25])).toEqual([]);
  });

  it('resolveHazards returns an empty list', () => {
    const encounter = new LobbyEncounter();

    const result = encounter.resolveHazards(
      {
        tick: 1,
        playerPos: [31, 25],
        world: {} as never,
        tickEvents: {} as never,
        logEvent: () => {},
        grantNextAttackSpeedup: () => {},
        spawnNpc: () => {},
        despawnNpc: () => {},
        ...createUnusedPlayerControlOps(),
      },
      {},
    );

    expect(result).toEqual([]);
  });

  it('takes no part in the NPC band: no band hooks and no per-NPC adapters', () => {
    const encounter: Encounter = new LobbyEncounter();

    expect([
      encounter.prepareNpcBand,
      encounter.moveNpc,
      encounter.resolveNpcLocalEffects,
      encounter.processNpcTick,
      encounter.completeNpcBand,
    ]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('default mechanics config has infiniteHealth disabled', () => {
    const encounter = new LobbyEncounter();

    expect(encounter.getDefaultMechanicsConfig()).toEqual({ infiniteHealth: false });
  });

  it('processPostTick returns an empty list', () => {
    const encounter = new LobbyEncounter();

    const result = encounter.processPostTick(
      {
        tick: 1,
        playerPos: [31, 25],
        world: {} as never,
        tickEvents: {} as never,
        logEvent: () => {},
        grantNextAttackSpeedup: () => {},
        spawnNpc: () => {},
        despawnNpc: () => {},
        ...createUnusedPlayerControlOps(),
      },
      {},
    );

    expect(result).toEqual([]);
  });

  it('returns fresh encounter state objects each call', () => {
    const encounter = new LobbyEncounter();

    const stateOne = encounter.getSnapshot().state;
    const stateTwo = encounter.getSnapshot().state;

    expect(stateOne).not.toBe(stateTwo);
    (stateOne as Record<string, unknown>).marker = 1;
    expect((stateTwo as Record<string, unknown>).marker).toBeUndefined();
  });

  it('returns fresh encounter visuals objects each call', () => {
    const encounter = new LobbyEncounter();

    const visualsOne = encounter.getSnapshot().visuals;
    const visualsTwo = encounter.getSnapshot().visuals;

    expect(visualsOne).not.toBe(visualsTwo);
    expect(visualsOne).toEqual({});
    expect(visualsTwo).toEqual({});

    (visualsOne as Record<string, unknown>).marker = 42;
    expect(visualsOne).toEqual({ marker: 42 });
    expect(visualsTwo).toEqual({});
  });
  it('SimulationEngine advances 10 ticks with LobbyEncounter without crashing', () => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter(), objTypeLoader: null });

    for (let i = 0; i < 10; i += 1) {
      expect(() => engine.advanceTick([31, 25])).not.toThrow();
    }

    const state = engine.getState();
    expect(state.currentTick).toBe(10);
    expect(state.npcs).toEqual([]);
    expect(state.isAlive).toBe(true);
  });
});
