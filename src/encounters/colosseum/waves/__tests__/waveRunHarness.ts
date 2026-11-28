import type { NpcActor } from '../../../../core/actors/NpcActor';
import type { EncounterModifierSelection } from '../../../../core/encounters/encounterFactory';
import { isSolHereditSnapshot } from '../../../../core/encounters/snapshot';
import type { GameEvent } from '../../../../core/events/types';
import { SimulationEngine } from '../../../../core/SimulationEngine';
import type { WorldState } from '../../../../core/WorldState';
import { enqueueEnginePendingHit } from '../../../../test/helpers/pendingHits';
import type { MechanicsConfig } from '../../../../types/simulation';
import { COLOSSEUM_START_WAVE_KEY } from '../../../solHeredit/controls';
import { SolHereditEncounter } from '../../../solHeredit/SolHereditEncounter';
import type { ColosseumModifierId } from '../../modifiers/definitions';
import { isColosseumModifierActor } from '../../modifiers/waveCleanup';
import { type ColosseumRunPublicState, colosseumRunState } from '../snapshot';

/**
 * A Fortis Colosseum run started on `startWave` with the configured `modifiers` (none by default),
 * with infinite health so a test can play it through.
 */
export function startRun(
  startWave: number,
  seed = 7,
  mechanics: Partial<MechanicsConfig> = {},
  modifiers: EncounterModifierSelection = {},
) {
  const encounter = new SolHereditEncounter(seed, modifiers);
  const engine = new SimulationEngine({
    encounter,
    combatRandom: () => 0.5,
    mechanics: { infiniteHealth: true, [COLOSSEUM_START_WAVE_KEY]: String(startWave), ...mechanics },
  });
  const world = Reflect.get(engine, 'worldState') as WorldState;
  return { encounter, engine, world };
}

export type Run = ReturnType<typeof startRun>;

export function snapshotState(run: Run) {
  const snapshot = run.engine.getEncounterSnapshot();
  if (!isSolHereditSnapshot(snapshot)) throw new TypeError('Not a Sol Heredit snapshot');
  return snapshot.state;
}

export function runState(run: Run): ColosseumRunPublicState {
  return colosseumRunState(snapshotState(run));
}

/** Advances one tick standing still (or toward `target`), returning its events. */
export function step(run: Run, target = run.engine.getState().playerPosition): readonly GameEvent[] {
  const before = run.engine.currentTick;
  run.engine.advanceTick(target);
  if (run.engine.currentTick === before) throw new Error(`the run stopped at tick ${before}`);
  return run.engine.getLastTickEvents();
}

export function advanceTo(run: Run, tick: number): Map<number, readonly GameEvent[]> {
  const events = new Map<number, readonly GameEvent[]>();
  while (run.engine.currentTick < tick) {
    const tickEvents = step(run);
    events.set(run.engine.currentTick, tickEvents);
  }
  return events;
}

export function gameMessages(events: readonly GameEvent[] | undefined): string[] {
  return (events ?? []).flatMap((event) =>
    event.type === 'game_message' && event.kind === 'game'
      ? [(event.segments as readonly { text: string }[]).map((segment) => segment.text).join('')]
      : [],
  );
}

/** Queues the intermission's Continue for `modifierId` (the first open option by default). */
export function confirm(run: Run, modifierId?: ColosseumModifierId, wave?: number): void {
  const offer = runState(run).offer;
  if (!offer) throw new Error(`No open offer at tick ${run.engine.currentTick}`);
  run.engine.queueEncounterCommand({
    encounter: 'sol_heredit',
    type: 'confirm-modifier',
    wave: wave ?? offer.wave,
    modifierId: modifierId ?? offer.options[0]!.id,
  });
}

/** The wave's required fighters: its NPCs other than the modifier actors (and the gibs). */
export function waveFighters(run: Run): NpcActor[] {
  return run.world.getNpcs().filter((npc) => npc.id.startsWith('colosseum_w') && !isColosseumModifierActor(npc));
}

/** A lethal player hit landing on the target's next turn. */
export function kill(run: Run, npc: NpcActor): void {
  const tick = run.engine.currentTick;
  enqueueEnginePendingHit(run.engine, {
    sourceId: 'player',
    targetId: npc.id,
    style: 'typeless',
    attackKind: 'typeless',
    launchTick: tick,
    impactTick: tick + 1,
    rolledDamage: npc.vitals.hp,
    accuracySucceeded: true,
  });
}

/** Kills every living fighter each tick until the wave completes; returns the completion tick. */
export function clearWave(run: Run, limit = 400): number {
  const start = run.engine.currentTick;
  while (run.engine.currentTick < start + limit) {
    for (const npc of waveFighters(run)) if (npc.alive && npc.vitals.hp > 0) kill(run, npc);
    step(run);
    const state = runState(run);
    if (state.stage === 'intermission' && state.waveCompletedTick === run.engine.currentTick)
      return state.waveCompletedTick;
  }
  throw new Error(`wave ${runState(run).wave} did not complete within ${limit} ticks`);
}

/** Advances to the open offer, confirms its first option and advances to the wave's start. */
export function confirmAndStart(run: Run, modifierId?: ColosseumModifierId): number {
  while (runState(run).offer === null) step(run);
  confirm(run, modifierId);
  step(run);
  const start = runState(run).waveStartTick;
  if (start === null) throw new Error('The confirm was refused');
  advanceTo(run, start);
  return start;
}
