import { afterEach, describe, expect, it } from 'vitest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import type { EncounterModifierSelection } from '../../../core/encounters/encounterFactory';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import type { GameEvent } from '../../../core/events/types';
import { SimulationEngine } from '../../../core/SimulationEngine';
import type { WorldState } from '../../../core/WorldState';
import { SOL_ACTOR_ID } from '../../../npcs/colosseum/constants';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import type { ColosseumModifierState } from '../../colosseum/modifiers/rules';
import { healingTotemDefinition } from '../../colosseum/modifiers/totemic';
import {
  clearWave,
  confirmAndStart,
  type Run,
  runState,
  startRun,
  step,
} from '../../colosseum/waves/__tests__/waveRunHarness';
import { SolHereditEncounter } from '../SolHereditEncounter';

const originalArena = getArenaConfig();
const originalFallback = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(originalArena, originalFallback));

/** What Sol's stage does on a tick, with ids and ticks made relative so two fights compare. */
function signature(events: readonly GameEvent[], world: WorldState): string {
  const sol = world.getNpc(SOL_ACTOR_ID);
  const parts = events.flatMap((event) => {
    if (event.type === 'overhead_text') return [`say:${event.overheadText}`];
    if (event.type === 'sol_beam_prepared') return [`beam:${(event as { fireInTicks?: number }).fireInTicks}`];
    if (isEncounterVisualEvent(event))
      return [`visual:${JSON.stringify(event.animations.map((animation) => animation.clipId))}`];
    return [];
  });
  const npcs = world
    .getNpcs()
    .map((npc) => `${npc.id}@${npc.position.join(',')}:${npc.vitals.hp}:${npc.alive}`)
    .sort();
  return [`sol ${sol?.position.join(',')} ${sol?.vitals.hp}`, ...npcs, ...parts].join('|');
}

/** Hits Sol for 30 every third tick from his control tick until the run ends (death + 9). */
function fight(engine: SimulationEngine, world: WorldState, control: number): string[] {
  const out: string[] = [];
  let deathTick: number | null = null;
  // Adjacent to his spawn footprint, so his opening attack is due at C+5 rather than on reach.
  const player = world.getPlayer()!;
  player.position = [33, 35];
  player.previousPosition = [33, 35];
  world.occupancy.reconcile(world.actors.values());
  for (let offset = 1; deathTick === null || (engine.canAdvance() && engine.currentTick < deathTick + 12); offset++) {
    const sol = world.getNpc(SOL_ACTOR_ID);
    if (sol?.alive && offset % 3 === 0) {
      enqueueEnginePendingHit(engine, {
        sourceId: 'player',
        targetId: SOL_ACTOR_ID,
        style: 'typeless',
        attackKind: 'typeless',
        launchTick: engine.currentTick,
        impactTick: engine.currentTick + 1,
        rolledDamage: 30,
        accuracySucceeded: true,
      });
    }
    // A run through the waves may own Totemic; its totem dies as it appears, in both fights alike.
    for (const totem of world.getNpcs().filter((npc) => healingTotemDefinition.isActor(npc) && npc.alive)) {
      enqueueEnginePendingHit(engine, {
        sourceId: 'player',
        targetId: totem.id,
        style: 'typeless',
        attackKind: 'typeless',
        launchTick: engine.currentTick,
        impactTick: engine.currentTick + 1,
        rolledDamage: 1,
        accuracySucceeded: true,
      });
    }
    engine.advanceTick(engine.getState().playerPosition);
    out.push(`${engine.currentTick - control}: ${signature(engine.getLastTickEvents(), world)}`);
    if (deathTick === null && sol && !sol.alive) deathTick = engine.currentTick;
    if (offset > 600) throw new Error(`Sol never died: ${out.slice(-2).join(' // ')}`);
  }
  out.push(`outcome ${JSON.stringify({ ...engine.getEncounterOutcome(), decisiveTick: 0, completionTick: 0 })}`);
  return out;
}

/** A run reaching Sol from wave 11, holding `forced` modifiers by his control tick. */
function reachSol(seed: number, forced: EncounterModifierSelection): { run: Run; control: number } {
  const run = startRun(11, seed);
  confirmAndStart(run);
  clearWave(run);
  const modifiers = Reflect.get(run.encounter, 'modifierState') as ColosseumModifierState;
  for (const [id, tier] of Object.entries(forced)) {
    for (let next = (modifiers.selection[id] ?? 0) + 1; next <= (tier ?? 0); next++)
      modifiers.acceptModifier(id as Parameters<ColosseumModifierState['acceptModifier']>[0], next);
  }
  confirmAndStart(run);
  const control = runState(run).solControlTick!;
  while (run.engine.currentTick < control) step(run);
  return { run, control };
}

describe('Sol after the waves (C > 0)', () => {
  it.each<{ seed: number; forced: EncounterModifierSelection }>([
    { seed: 3, forced: {} },
    { seed: 8, forced: { quartet: 1, bees: 2, solarflare: 1, volatility: 2 } },
  ])('plays the direct fight shifted by C (seed $seed, $forced)', ({ seed, forced }) => {
    const { run, control } = reachSol(seed, forced);
    expect(control).toBeGreaterThan(0);
    const selection = run.engine.getEncounterSnapshot().state as { modifiers: EncounterModifierSelection };
    const direct = new SimulationEngine({
      encounter: new SolHereditEncounter(seed, selection.modifiers),
      combatRandom: () => 0.5,
      mechanics: { infiniteHealth: true },
    });
    const directWorld = Reflect.get(direct, 'worldState') as WorldState;
    const shifted = fight(run.engine, run.world, control);
    const expected = fight(direct, directWorld, 0);
    expect(shifted).toEqual(expected);
    // The shifted fight's opening is relative to C: the taunt at C+3, the victory at death+9.
    expect(shifted.find((line) => line.includes('say:'))?.startsWith('3: ')).toBe(true);
    expect(run.engine.getEncounterOutcome().phase).toBe('victory');
  });
});
