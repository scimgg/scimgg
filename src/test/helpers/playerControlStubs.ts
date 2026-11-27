import type { EncounterContext } from '../../core/encounters/types';

type PlayerControlOps = Pick<EncounterContext, 'teleportPlayer' | 'lockPlayerActionsUntil'>;

function unexpected(name: keyof PlayerControlOps): never {
  throw new Error(`${name} was called on a hand-built context; drive a real SimulationEngine to test player control`);
}

/**
 * The engine-owned player-control operations, as stubs that throw, for tests that build an
 * `EncounterContext` (or a hook context) by hand and do not exercise player control. Never give
 * them behavior: a teleport or an action lock is tested against a real `SimulationEngine`.
 */
export function createUnusedPlayerControlOps(): PlayerControlOps {
  return {
    teleportPlayer: () => unexpected('teleportPlayer'),
    lockPlayerActionsUntil: () => unexpected('lockPlayerActionsUntil'),
  };
}
