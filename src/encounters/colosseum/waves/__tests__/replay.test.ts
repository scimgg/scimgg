import { afterEach, describe, expect, it } from 'vitest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../../core/constants';
import type { EncounterModifierSelection } from '../../../../core/encounters/encounterFactory';
import { isSolHereditSnapshot } from '../../../../core/encounters/snapshot';
import { ReplayRecorder } from '../../../../core/ReplayRecorder';
import type { SimulationEngine } from '../../../../core/SimulationEngine';
import type { WorldState } from '../../../../core/WorldState';
import { SOL_ACTOR_ID } from '../../../../npcs/colosseum/constants';
import { MINOTAUR_ROUTEFIND_NPC_ID } from '../../../../npcs/colosseum/minotaur';
import { shockwaveColossusDefinition } from '../../../../npcs/colosseum/shockwaveColossus';
import { diffResumableState } from '../../../../replay/resumableState';
import { createEmptyCombatSupplies } from '../../../../types/encounterLoadout';
import { createEmptyInventory } from '../../../../types/inventory';
import { createDefaultStats } from '../../../../types/playerState';
import type { Coordinate, MechanicsConfig } from '../../../../types/simulation';
import { createSimulationEngineForNewRun, reconstructReplayPrefix } from '../../../simulationEngineFactory';
import {
  COLOSSEUM_SPAWN_LAYOUT_KEY,
  COLOSSEUM_START_TILE_KEY,
  COLOSSEUM_START_WAVE_KEY,
} from '../../../solHeredit/controls';
import { colosseumRunState } from '../snapshot';

const originalArena = getArenaConfig();
const originalFallback = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(originalArena, originalFallback));

/** A new run as the app starts one: an empty modifier set is sent as no options at all. */
function newRun(
  startWave: string | undefined,
  modifiers: EncounterModifierSelection = {},
  mechanics: Partial<MechanicsConfig> = {},
) {
  return createSimulationEngineForNewRun({
    encounterConfig: {
      kind: 'sol_heredit',
      mechanics: {
        infiniteHealth: true,
        ...(startWave === undefined ? {} : { [COLOSSEUM_START_WAVE_KEY]: startWave }),
        ...mechanics,
      },
      ...(Object.keys(modifiers).length > 0 ? { options: { modifiers } } : {}),
    },
    enableIntro: false,
    stats: createDefaultStats(),
    inventory: createEmptyInventory(),
    equipment: {},
    combatSupplies: createEmptyCombatSupplies(),
    attackStylePerCategory: {},
    combatSeed: 0x1234abcd,
  });
}

function run(engine: SimulationEngine) {
  const snapshot = engine.getEncounterSnapshot();
  if (!isSolHereditSnapshot(snapshot)) throw new TypeError('Not a Sol Heredit run');
  return colosseumRunState(snapshot.state);
}

describe('recording a wave run', () => {
  it('rebuilds the same run across a choice, a wave, the hand-off and Sol, from recorded inputs only', () => {
    const original = newRun('11');
    const config = original.getRunConfig();
    expect(config.encounter.seeds).toEqual({ encounterSeed: expect.any(Number) });
    const recorder = new ReplayRecorder();
    const position = original.getState().playerPosition;
    recorder.startRun(config);
    recorder.recordFrame(0, position, original.getState(), []);
    const marks: Record<string, number> = {};
    for (let tick = 1; tick <= 400; tick++) {
      const state = run(original);
      const offer = state.offer;
      if (offer) {
        const command = {
          encounter: 'sol_heredit',
          type: 'confirm-modifier',
          wave: offer.wave,
          modifierId: offer.options[offer.options.length - 1]!.id,
        } as const;
        expect(original.queueEncounterCommand(command)).toBe(true);
        recorder.recordAction({ type: 'encounterCommand', command });
        marks[`choice${offer.wave}`] ??= tick;
      }
      // The boss-HP tool takes the first NPC while no boss is up: a recorded way to clear waves.
      if (state.stage === 'wave' || state.solControlTick !== null) {
        original.setBossHp(0);
        recorder.recordAction({ type: 'setBossHp', hp: 0 });
      }
      original.advanceTick(position);
      recorder.recordFrame(tick, position, original.getState(), original.getLastTickEvents());
      if (run(original).solControlTick !== null && original.getState().npcs.some((npc) => npc.id === SOL_ACTOR_ID)) {
        marks.control ??= tick;
      }
      if (marks.control !== undefined && tick >= marks.control + 15) break;
    }
    expect(marks.choice11).toBeDefined();
    expect(marks.choice12).toBeDefined();
    expect(marks.control).toBeDefined();
    const frames = recorder.exportData().frames;
    for (const tick of [
      0,
      marks.choice11!,
      marks.choice11! + 6,
      marks.choice12! + 1,
      marks.control!,
      frames.length - 1,
    ]) {
      const rebuilt = reconstructReplayPrefix(config, frames, tick, null);
      if (!rebuilt) throw new Error(`No rebuild at ${tick}`);
      const recorded = recorder.getFrame(tick);
      if (!recorded) throw new Error(`No frame ${tick}`);
      expect([tick, diffResumableState(recorded.state, rebuilt.getState())]).toEqual([tick, []]);
    }
  });

  it('rebuilds where a wave spawns and reinforces from the tiles the player walked', () => {
    const original = newRun('1');
    const config = original.getRunConfig();
    const recorder = new ReplayRecorder();
    recorder.startRun(config);
    recorder.recordFrame(0, original.getState().playerPosition, original.getState(), []);
    const jaguar = (engine: SimulationEngine) => engine.getState().npcs.find((npc) => npc.id.includes('jaguarWarrior'));
    let t0: number | null = null;
    let reinforced: number | null = null;
    for (let tick = 1; tick <= 120 && reinforced === null; tick++) {
      const offer = run(original).offer;
      if (offer) {
        const command = {
          encounter: 'sol_heredit',
          type: 'confirm-modifier',
          wave: offer.wave,
          modifierId: offer.options[0]!.id,
        } as const;
        expect(original.queueEncounterCommand(command)).toBe(true);
        recorder.recordAction({ type: 'encounterCommand', command });
      }
      t0 ??= run(original).waveStartTick;
      // Off the opening tile before T0, a click away on T0, then north of center for the gate.
      const target: Coordinate = t0 === null || tick < t0 ? [28, 32] : tick === t0 ? [44, 22] : [22, 40];
      original.advanceTick(target);
      recorder.recordFrame(tick, target, original.getState(), original.getLastTickEvents());
      if (jaguar(original)) reinforced = tick;
    }
    expect(reinforced).toBe(t0! + 66);
    expect(jaguar(original)?.position[1]).toBe(48);
    const frames = recorder.exportData().frames;
    for (const tick of [t0! - 1, t0!, t0! + 65, t0! + 66]) {
      const rebuilt = reconstructReplayPrefix(config, frames, tick, null);
      if (!rebuilt) throw new Error(`No rebuild at ${tick}`);
      const recorded = recorder.getFrame(tick);
      if (!recorded) throw new Error(`No frame ${tick}`);
      expect([tick, diffResumableState(recorded.state, rebuilt.getState())]).toEqual([tick, []]);
    }
  });

  it('records a direct start as it always was: no start-wave key means Sol at C = 0', () => {
    const engine = newRun(undefined);
    expect(run(engine)).toMatchObject({ startWave: 12, stage: 'sol', solControlTick: 0 });
    expect(engine.getState().npcs.map((npc) => npc.id)).toEqual([SOL_ACTOR_ID]);
    expect(engine.getRunConfig().encounter.seeds).toEqual({ encounterSeed: expect.any(Number) });
  });

  it('rebuilds a start wave recorded without a set as one with none, the way an empty set is sent', () => {
    const original = newRun('5');
    const config = original.getRunConfig();
    expect(config.bootstrap?.encounterConfig).toBeUndefined();
    const recorder = new ReplayRecorder();
    recorder.startRun(config);
    recorder.recordFrame(0, original.getState().playerPosition, original.getState(), []);
    const rebuilt = reconstructReplayPrefix(config, recorder.exportData().frames, 0, null)!;
    expect(run(rebuilt)).toMatchObject({ startWave: 5, picks: [] });
    // The recorded opening and its rebuild stand on the wave start's tile, facing east.
    const opening = { playerPosition: [23, 38], playerFacingAngle: 1536 };
    expect(recorder.getFrame(0)?.state).toMatchObject(opening);
    expect(rebuilt.getState()).toMatchObject(opening);
  });

  it('rebuilds a start wave from the recorded set, Dynamic Duo and Red Flag included', () => {
    const set = { dynamicDuo: 1, redFlag: 1, frailty: 1 } as const;
    const original = newRun('8', set);
    const config = original.getRunConfig();
    expect(config.bootstrap?.encounterConfig).toEqual({ modifiers: set });
    // A new run draws a fresh encounter seed, so the offer varies: take any choice but Frailty II
    // (offered first for about a fifth of seeds), so the set's Frailty I alone sets the maximum.
    const choice = run(original).offer!.options.find((option) => option.id !== 'frailty')!;
    const command = {
      encounter: 'sol_heredit',
      type: 'confirm-modifier',
      wave: 8,
      modifierId: choice.id,
    } as const;
    const recorder = new ReplayRecorder();
    const position = original.getState().playerPosition;
    recorder.startRun(config);
    recorder.recordFrame(0, position, original.getState(), []);
    expect(original.queueEncounterCommand(command)).toBe(true);
    recorder.recordAction({ type: 'encounterCommand', command });
    let waveStart: number | null = null;
    for (let tick = 1; waveStart === null || tick <= waveStart + 70; tick++) {
      original.advanceTick(position);
      recorder.recordFrame(tick, position, original.getState(), original.getLastTickEvents());
      waveStart ??= run(original).stage === 'wave' ? tick : null;
    }
    const world = Reflect.get(original, 'worldState') as WorldState;
    expect(world.getNpcs().filter(shockwaveColossusDefinition.isActor)).toHaveLength(2);
    expect(world.getNpcs().some((npc) => npc.npcTypeId === MINOTAUR_ROUTEFIND_NPC_ID)).toBe(true);
    // The set took effect at T0: Frailty I's 90 maximum.
    expect(original.getState().maxHP).toBe(90);
    const frames = recorder.exportData().frames;
    for (const tick of [waveStart!, waveStart! + 66, frames.length - 1]) {
      const rebuilt = reconstructReplayPrefix(config, frames, tick, null);
      if (!rebuilt) throw new Error(`No rebuild at ${tick}`);
      expect([tick, diffResumableState(recorder.getFrame(tick)!.state, rebuilt.getState())]).toEqual([tick, []]);
    }
  });

  it('rebuilds a practice start: its layout, its start tile and a pick off the offer', () => {
    // Wave 2: the shaman on (25,34), 4 from the chosen start tile (29,36); the javelin at random.
    const practice = { [COLOSSEUM_SPAWN_LAYOUT_KEY]: '2:----------s-', [COLOSSEUM_START_TILE_KEY]: '29,36' };
    const original = newRun('2', {}, practice);
    const config = original.getRunConfig();
    expect(config.bootstrap?.mechanicsConfig).toMatchObject(practice);
    expect(config.bootstrap?.startPosition).toEqual([29, 36]);
    const offer = run(original).offer!;
    const choice = offer.eligible.find((pick) => !offer.options.some((option) => option.id === pick.id))!;
    const command = { encounter: 'sol_heredit', type: 'confirm-modifier', wave: 2, modifierId: choice.id } as const;
    const recorder = new ReplayRecorder();
    const position = original.getState().playerPosition;
    recorder.startRun(config);
    recorder.recordFrame(0, position, original.getState(), []);
    expect(original.queueEncounterCommand(command)).toBe(true);
    recorder.recordAction({ type: 'encounterCommand', command });
    let waveStart: number | null = null;
    let shaman: Coordinate | undefined;
    for (let tick = 1; waveStart === null || tick <= waveStart + 3; tick++) {
      original.advanceTick(position);
      recorder.recordFrame(tick, position, original.getState(), original.getLastTickEvents());
      if (waveStart === null && run(original).stage === 'wave') {
        waveStart = tick;
        shaman = original.getState().npcs.find((npc) => npc.id.includes('serpentShaman'))?.position;
      }
    }
    expect(run(original).picks.at(-1)).toMatchObject({ origin: 'live', id: choice.id, tier: choice.tier });
    expect(shaman).toEqual([25, 34]);
    const frames = recorder.exportData().frames;
    for (const tick of [0, waveStart! - 1, waveStart!, frames.length - 1]) {
      const rebuilt = reconstructReplayPrefix(config, frames, tick, null);
      if (!rebuilt) throw new Error(`No rebuild at ${tick}`);
      expect([tick, diffResumableState(recorder.getFrame(tick)!.state, rebuilt.getState())]).toEqual([tick, []]);
      // A viewer's own setup on tick zero cannot reconfigure the recorded start.
      rebuilt.setMechanicsConfig({ ...rebuilt.getMechanicsConfig(), [COLOSSEUM_SPAWN_LAYOUT_KEY]: '' });
      expect(rebuilt.getMechanicsConfig()).toMatchObject(practice);
    }
  });
});
