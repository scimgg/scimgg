import { describe, expect, it } from 'vitest';

import { PLAYER_LANDING_MIN } from '../../../encounters/yamaP3/constants';
import { YamaEncounter } from '../../../encounters/yamaP3/YamaEncounter';
import { ZULRAH_PLAYER_START, ZulrahEncounter } from '../../../encounters/zulrah/ZulrahEncounter';
import type { Coordinate } from '../../../types/simulation';
import { ReplayRecorder } from '../../ReplayRecorder';
import { SimulationEngine } from '../../SimulationEngine';
import type { Encounter } from '../types';

/**
 * `EncounterSnapshot` payloads are DTOs, not live objects.
 *
 * `ReplayRecorder.snapshotStateForReplay` runs `structuredClone` over the whole `SimulationState`
 * every frame, so a payload that smuggled in a function or a class instance would throw
 * `DataCloneError` at runtime — and only for the encounter that did it, only once a replay was
 * being recorded.
 *
 * This is a plain-DTO policy, not purely a cloneability one: `structuredClone` copies Maps and
 * Sets happily, but a snapshot that shipped one would still be the wrong shape for a serialized
 * frame.
 *
 * Snapshots are taken from the REAL producers driven through a real engine, not hand-built, so a
 * field added to a producer is covered without touching this file.
 */

const ENCOUNTERS: readonly { readonly label: string; readonly make: () => Encounter; readonly start: Coordinate }[] = [
  { label: 'Yama P3', make: () => new YamaEncounter(undefined, 0), start: PLAYER_LANDING_MIN },
  { label: 'Zulrah', make: () => new ZulrahEncounter(0), start: ZULRAH_PLAYER_START },
];

/** Every value reachable from `value`, so a nested offender cannot hide. */
function* walk(value: unknown, path = 'snapshot'): Generator<{ readonly path: string; readonly value: unknown }> {
  yield { path, value };
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const [i, entry] of value.entries()) yield* walk(entry, `${path}[${i}]`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) yield* walk(entry, `${path}.${key}`);
}

describe('encounter snapshots are replay-safe plain data', () => {
  for (const { label, make, start } of ENCOUNTERS) {
    it(`${label}: contains only plain data`, () => {
      const engine = new SimulationEngine({ encounter: make(), startPos: [...start] as Coordinate });
      engine.setMechanicsConfig({ infiniteHealth: true });
      // Advance far enough for hazards, spawns and visual arrays to be populated.
      for (let i = 0; i < 40; i += 1) engine.advanceTick([...start] as Coordinate);

      const snapshot = engine.getEncounterSnapshot();
      for (const { path, value } of walk(snapshot)) {
        expect(typeof value, `${path} must not be a function`).not.toBe('function');
        expect(typeof value, `${path} must not be a symbol`).not.toBe('symbol');
        expect(value instanceof Map, `${path} must not be a Map`).toBe(false);
        expect(value instanceof Set, `${path} must not be a Set`).toBe(false);
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          expect(Object.getPrototypeOf(value), `${path} must be a plain object, not a class instance`).toBe(
            Object.prototype,
          );
        }
      }
    });

    it(`${label}: survives the real replay recorder round-trip`, () => {
      const engine = new SimulationEngine({ encounter: make(), startPos: [...start] as Coordinate });
      engine.setMechanicsConfig({ infiniteHealth: true });
      const recorder = new ReplayRecorder();

      for (let i = 0; i < 40; i += 1) {
        engine.advanceTick([...start] as Coordinate);
        const state = engine.getState();
        // Throws DataCloneError if the payload is not structured-cloneable.
        recorder.recordFrame(state.currentTick, [...start] as Coordinate, state, engine.getLastTickEvents());
      }

      const replayed = recorder.getFrame(recorder.getFrameCount() - 1);
      expect(replayed).toBeDefined();
      expect(replayed?.state.encounter.kind).toBe(engine.getEncounterSnapshot().kind);
      // The clone must be a copy, not the live object the engine still mutates.
      expect(replayed?.state.encounter).not.toBe(engine.getEncounterSnapshot());
    });
  }
});
