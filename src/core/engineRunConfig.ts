import { z } from 'zod';
import type { PlayerEquipment } from '../rs/model/PlayerModelLoader';
import type { CombatSupplies } from '../types/encounterLoadout';
import type { Inventory } from '../types/inventory';
import { INVENTORY_SIZE } from '../types/inventory';
import type { PlayerStats } from '../types/playerState';
import type { Coordinate, MechanicsConfig } from '../types/simulation';
import type { EncounterCompletionOwnership } from './encounters/types';
import { MAX_REPLAY_BOOTSTRAP_ATTACK_STYLES, ReplaySafetyError } from './replaySafety';

/**
 * Everything a run cannot re-derive from its own recording.
 *
 * Replay takeover rebuilds a live engine by re-simulating the recorded prefix, because the
 * encounter's state machine (wave schedules, flare/fireball sets, attack-policy cursors, RNG
 * stream positions) exists only inside the `Encounter` and is absent from `SimulationState`.
 * That re-simulation is only sound if every input to the original run is reproduced exactly:
 * anything re-rolled, defaulted, or read from the VIEWER's live settings at takeover silently
 * produces a different fight.
 */
export interface EngineRunBootstrap {
  /**
   * Guards a reconstruction against a bootstrap written by a different engine. Bump it when a
   * field below changes meaning, or when re-simulating recorded inputs would no longer reproduce
   * the recorded state: a recording with any other version then fails the parse and plays back
   * without takeover rather than reconstructing a fight that never happened.
   */
  readonly version: number;
  /** The tile the run actually started on. Encounters randomize this and it is not in `seeds`. */
  readonly startPosition: Coordinate;
  /**
   * Unboosted levels, as configured. A recorded frame's `stats` carry drained/boosted CURRENT
   * values, so feeding one back into the constructor bakes a mid-fight state in as the baseline.
   */
  readonly baseStats: PlayerStats;
  readonly startHp?: number;
  readonly enableIntro: boolean;
  /** Encounter constructor config (invocations). Dropping it rebuilds a different encounter. */
  readonly encounterConfig?: Record<string, unknown>;
  /** Applied before `applyPrepotEffects`, which reads `autoPrepot` from it. */
  readonly mechanicsConfig: Partial<MechanicsConfig>;
  readonly inventory: Inventory;
  readonly equipment: PlayerEquipment;
  readonly combatSupplies: CombatSupplies;
  readonly attackStylePerCategory: Record<string, number>;
  /** Whether the run start applied Auto-Prepot. Reproduced rather than assumed. */
  readonly prepotApplied: boolean;
  /** Seeds every combat roll for the run. See `SimulationEngine.rollCombat`. */
  readonly combatSeed: number;
}

// Version 11 is the bootstrap of a recording under the retired `zuk` kind (`encounterSeed`), where
// TzKal-Zuk is his own encounter rather than the Inferno's wave 69 (`inferno`, `runSeed`, the run
// setup applied before the world is built). Such a recording is never re-read as an Inferno run: it
// plays back as recorded, without takeover.
// Version 15: recoil lands the tick after the hit, and poison and venom share one counter (`core/poison.ts`).
export const ENGINE_RUN_BOOTSTRAP_VERSION = 15;

export interface EngineRunConfig {
  completionOwnership: EncounterCompletionOwnership;
  encounter: {
    kind: string;
    seeds: Record<string, unknown>;
  };
  /**
   * Without a bootstrap the recording still plays back — the frames are all playback needs — but
   * it cannot be taken over, because reconstructing it means guessing at the inputs above.
   */
  bootstrap?: EngineRunBootstrap;
}

/**
 * A recording's bootstrap may come from another engine version or be malformed, and
 * reconstruction feeds it straight into a live engine, so it is parsed here instead of being
 * asserted: a malformed `combatSeed` would otherwise poison every roll of the resumed fight.
 *
 * Leaf shapes (stats, inventory, equipment, supplies) are passed through rather than
 * re-declared: they are the engine's own types, and a second declaration here would be a
 * second place to update every time one of them gains a field.
 */
const engineRunBootstrapSchema = z.object({
  version: z.number().int(),
  startPosition: z.tuple([z.number().finite(), z.number().finite()]),
  baseStats: z.object({}).passthrough(),
  startHp: z.number().finite().optional(),
  enableIntro: z.boolean(),
  encounterConfig: z.record(z.string(), z.unknown()).optional(),
  mechanicsConfig: z.record(z.string(), z.unknown()),
  inventory: z.array(z.unknown()),
  equipment: z.object({}).passthrough(),
  combatSupplies: z.object({}).passthrough(),
  attackStylePerCategory: z.record(z.string(), z.number()),
  prepotApplied: z.boolean(),
  combatSeed: z.number().int().nonnegative(),
});

/**
 * Returns the bootstrap only when it is present, parseable, and written by this engine version.
 * Every other case is the same outcome for the caller — no takeover — so they are not
 * distinguished here.
 */
export function parseEngineRunBootstrap(raw: unknown): EngineRunBootstrap | null {
  try {
    assertReplayTakeoverBootstrap(raw);
  } catch (error) {
    if (error instanceof ReplaySafetyError) return null;
    throw error;
  }
  const parsed = engineRunBootstrapSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.version !== ENGINE_RUN_BOOTSTRAP_VERSION) return null;
  return parsed.data as unknown as EngineRunBootstrap;
}

export function assertReplayTakeoverBootstrap(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
  if ('inventory' in raw && Array.isArray(raw.inventory) && raw.inventory.length > INVENTORY_SIZE)
    throw new ReplaySafetyError('takeover-work-limit', { actual: raw.inventory.length, limit: INVENTORY_SIZE });
  if (
    'attackStylePerCategory' in raw &&
    typeof raw.attackStylePerCategory === 'object' &&
    raw.attackStylePerCategory !== null
  ) {
    const actual = Object.keys(raw.attackStylePerCategory).length;
    if (actual > MAX_REPLAY_BOOTSTRAP_ATTACK_STYLES)
      throw new ReplaySafetyError('takeover-work-limit', { actual, limit: MAX_REPLAY_BOOTSTRAP_ATTACK_STYLES });
  }
}

/** Null when the recording has no bootstrap or carries one this engine cannot use. */
export function resolveRunBootstrap(runConfig: EngineRunConfig | null): EngineRunBootstrap | null {
  if (!runConfig) return null;
  return parseEngineRunBootstrap(runConfig.bootstrap);
}
