import { createHash } from 'node:crypto';
import type { ArenaConfig } from '../../../core/arena/ArenaConfig';
import { setResolvedArenaConfig } from '../../../core/constants';
import type { GameEvent } from '../../../core/events/types';
import { SimulationEngine, type SimulationEngineOptions } from '../../../core/SimulationEngine';
import type { WorldState } from '../../../core/WorldState';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import { INFERNO_START_WAVE_KEY } from '../controls';
import { InfernoEncounter, type InfernoEncounterOptions } from '../InfernoEncounter';

/**
 * Golden-trajectory driver for the decision-random parity check: a fixed, input-only script (player
 * clicks, prayers and periodic player hits) over several run seeds and start waves, digested per
 * tick. Every RNG site of the Inferno encounter is reached by some run (see the parity test's site
 * coverage), so a change to draw order, count or mapping changes a digest.
 */
export const PARITY_SEEDS = [3, 11, 2024] as const;
export const PARITY_START_WAVES = [4, 12, 23, 38, 52, 64, 67, 68] as const;
export const PARITY_TICKS = 260;

const LOOP: readonly Coordinate[] = [
  [30, 32],
  [33, 32],
  [33, 29],
  [30, 29],
];
const PRAYERS = [PrayerType.ProtectMagic, PrayerType.ProtectRange, null] as const;

function openArena(): ArenaConfig {
  const walkableTiles = new Set<string>();
  for (let x = 17; x <= 45; x++) for (let y = 17; y <= 46; y++) walkableTiles.add(`${x},${y}`);
  return {
    bounds: { minX: 17, maxX: 45, minY: 17, maxY: 46, width: 29, height: 30 },
    walkableTiles,
    collisionMap: null,
  };
}

function digestEvents(events: readonly GameEvent[]): unknown[] {
  const out: unknown[] = [];
  for (const event of events) {
    const { eventId: _eventId, ...rest } = event as GameEvent & Record<string, unknown>;
    switch (event.type) {
      case 'encounter_visual':
        // The goldens hash this batch under its former name. Drop the alias the next time they are
        // re-recorded for a deliberate mechanic change.
        out.push({ ...rest, type: 'inferno_visual' });
        break;
      case 'hit_applied':
      case 'hitsplat_spawned':
      case 'actor_died':
      case 'actor_despawned':
      case 'game_message':
      case 'zuk_attack':
      case 'movement':
      case 'attack_started':
      case 'projectile_spawned':
        out.push(rest);
        break;
      default:
        break;
    }
  }
  return out;
}

export interface ParityRun {
  readonly seed: number;
  readonly startWave: number;
  /** Rolling digest every 20 ticks and at the end. */
  readonly checkpoints: readonly string[];
}

export interface ParityOptions {
  readonly encounter?: InfernoEncounterOptions;
  readonly combatDecisions?: SimulationEngineOptions['combatDecisions'];
}

export function runParityTrajectory(seed: number, startWave: number, options: ParityOptions = {}): ParityRun {
  setResolvedArenaConfig('inferno', openArena());
  const encounter = new InfernoEncounter(seed, options.encounter);
  // Opened on wave 1 and moved to `startWave` at tick 0, as the golden trajectories were recorded
  // (the player keeps the landing tile; the default start, wave 69, would swap it).
  const engine = new SimulationEngine({
    encounter,
    combatSeed: seed,
    mechanics: { [INFERNO_START_WAVE_KEY]: '1' },
    ...(options.combatDecisions ? { combatDecisions: options.combatDecisions } : {}),
  });
  engine.setMechanicsConfig({ infiniteHealth: true, [INFERNO_START_WAVE_KEY]: String(startWave) });
  const world = Reflect.get(engine, 'worldState') as WorldState;
  const rolling = createHash('sha256');
  const checkpoints: string[] = [];
  for (let step = 0; step < PARITY_TICKS; step++) {
    const tick = engine.currentTick;
    if (tick % 25 === 0) engine.applyAction({ type: 'protectionPrayer', prayer: PRAYERS[(tick / 25) % 3] ?? null });
    if (tick % 3 === 0) {
      const target = world
        .getNpcs()
        .filter((npc) => npc.alive && npc.id.startsWith('inferno_') && !npc.id.startsWith('inferno_pillar'))
        .sort((left, right) => (left.id < right.id ? -1 : 1))[0];
      if (target) {
        enqueueEnginePendingHit(engine, {
          sourceId: 'player',
          targetId: target.id,
          style: 'typeless',
          attackKind: 'typeless',
          launchTick: tick,
          impactTick: tick + 1,
          rolledDamage: 24,
          accuracySucceeded: true,
        });
      }
    }
    engine.advanceTick([...(LOOP[Math.floor(tick / 20) % LOOP.length] ?? LOOP[0])]);
    const state = {
      tick: engine.currentTick,
      player: { position: world.getPlayer()?.position, hp: world.getPlayer()?.vitals.hp },
      npcs: world
        .getNpcs()
        .map((npc) => [npc.id, npc.npcTypeId, npc.position, npc.vitals.hp, npc.alive, npc.combat.targetId])
        .sort((left, right) => (String(left[0]) < String(right[0]) ? -1 : 1)),
      events: digestEvents(engine.getLastTickEvents()),
    };
    rolling.update(JSON.stringify(state));
    if ((step + 1) % 20 === 0 || step + 1 === PARITY_TICKS) checkpoints.push(rolling.copy().digest('hex').slice(0, 16));
  }
  return { seed, startWave, checkpoints };
}

export function runAllParityTrajectories(options: ParityOptions = {}): ParityRun[] {
  return PARITY_SEEDS.flatMap((seed) =>
    PARITY_START_WAVES.map((startWave) => runParityTrajectory(seed, startWave, options)),
  );
}
