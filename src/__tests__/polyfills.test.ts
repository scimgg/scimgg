import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EncounterVisualCue } from '../core/events/encounterVisual';
import { generateSparkVolley } from '../encounters/zuk/sparks';
import { createColosseumActor } from '../npcs/colosseum/actors';
import type { ColosseumVisualCue } from '../npcs/colosseum/visualEvents';
import { createInfernoActor } from '../npcs/inferno/actors';
import { installPolyfills } from '../polyfills';
import type { Coordinate, SimulationState } from '../types/simulation';

const builtins = [
  [Object, 'hasOwn'],
  [Array.prototype, 'at'],
] as const;
const descriptors = builtins.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key)!);
const nativeClone = globalThis.structuredClone;
const unscopablesAt = Object.getOwnPropertyDescriptor(Array.prototype[Symbol.unscopables], 'at');

afterEach(() => {
  builtins.forEach(([target, key], index) => {
    Object.defineProperty(target, key, descriptors[index]);
  });
  if (unscopablesAt) Object.defineProperty(Array.prototype[Symbol.unscopables], 'at', unscopablesAt);
  else delete Array.prototype[Symbol.unscopables].at;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function removeBuiltin(target: object, key: PropertyKey): void {
  Object.defineProperty(target, key, { value: undefined, writable: true, configurable: true });
}

function useCloneFallback(): void {
  vi.stubGlobal('structuredClone', undefined);
  installPolyfills();
}

describe('compatibility polyfill installation', () => {
  it('preserves existing implementations, including on repeated installation', () => {
    const clone = vi.fn();
    const randomUUID = vi.fn();
    vi.stubGlobal('structuredClone', clone);
    vi.stubGlobal('crypto', { randomUUID, getRandomValues: vi.fn() });
    installPolyfills();
    installPolyfills();
    builtins.forEach(([target, key], index) => {
      expect(Object.getOwnPropertyDescriptor(target, key)).toEqual(descriptors[index]);
    });
    expect(globalThis.structuredClone).toBe(clone);
    expect(crypto.randomUUID).toBe(randomUUID);
  });

  it('installs missing methods with native property descriptors and keeps the installed functions', () => {
    for (const [target, key] of builtins) removeBuiltin(target, key);
    vi.stubGlobal('structuredClone', undefined);
    vi.stubGlobal('crypto', { getRandomValues: vi.fn() });
    installPolyfills();
    const installed = [...builtins, [globalThis, 'structuredClone'], [crypto, 'randomUUID']] as const;
    const functions = installed.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key)!.value);
    installPolyfills();
    installed.forEach(([target, key], index) => {
      expect(Object.getOwnPropertyDescriptor(target, key)).toEqual({
        value: functions[index],
        writable: true,
        configurable: true,
        enumerable: false,
      });
      expect(typeof functions[index]).toBe('function');
    });
    expect(Array.prototype[Symbol.unscopables].at).toBe(true);
  });

  it('is the first import of every browser entry, before the bzip2 bootstrap', () => {
    for (const [entry, specifier] of [
      ['src/main.tsx', './polyfills'],
      ['src/harness/uiHarness.tsx', '../polyfills'],
      ['src/harness/uiHarnessGame.tsx', '../polyfills'],
    ]) {
      const source = readFileSync(entry, 'utf8');
      expect(source.match(/^import .*$/m)?.[0]).toBe(`import '${specifier}';`);
    }
  });
});

describe('Object.hasOwn fallback', () => {
  it('handles inherited keys, null prototypes, overridden hasOwnProperty and primitive receivers', () => {
    removeBuiltin(Object, 'hasOwn');
    installPolyfills();
    const symbol = Symbol('own');
    const value = Object.assign(Object.create({ inherited: true }), {
      own: undefined,
      hasOwnProperty: null,
      [symbol]: 1,
    });
    expect(Object.hasOwn(value, 'own')).toBe(true);
    expect(Object.hasOwn(value, 'inherited')).toBe(false);
    expect(Object.hasOwn(value, symbol)).toBe(true);
    expect(Object.hasOwn(Object.create(null), 'toString')).toBe(false);
    expect(Reflect.apply(Object.hasOwn, Object, ['abc', 1])).toBe(true);
    expect(() => Reflect.apply(Object.hasOwn, Object, [null, 'x'])).toThrow(TypeError);
    expect(() => Reflect.apply(Object.hasOwn, Object, [undefined, 'x'])).toThrow(TypeError);
  });

  it('rejects a null receiver before coercing the property key', () => {
    removeBuiltin(Object, 'hasOwn');
    installPolyfills();
    const key = { toString: vi.fn(() => 'key') };
    expect(() => Reflect.apply(Object.hasOwn, Object, [null, key])).toThrow(TypeError);
    expect(key.toString).not.toHaveBeenCalled();
  });
});

describe('Array.at fallback', () => {
  it('supports negative, fractional, missing, NaN and out-of-range array indices', () => {
    removeBuiltin(Array.prototype, 'at');
    installPolyfills();
    const array = ['a', 'b', 'c'];
    expect([-1, -2, -3, -4, 3, 1.9, -1.9, NaN, Infinity, -Infinity].map((i) => array.at(i))).toEqual([
      'c',
      'b',
      'a',
      undefined,
      undefined,
      'b',
      'c',
      'a',
      undefined,
      undefined,
    ]);
    expect(Reflect.apply(Array.prototype.at, array, [])).toBe('a');
    expect(Array.prototype.at.call({ 0: 'x', 1: 'y', length: 2 }, -1)).toBe('y');
    expect(Array.prototype.at.call({ 0: 'x', length: -1 }, 0)).toBeUndefined();
    // biome-ignore lint/suspicious/noSparseArray: a hole must read as undefined, like native .at.
    expect([, 'b'].at(0)).toBeUndefined();
    expect(() => Array.prototype.at.call(null, 0)).toThrow(TypeError);
    expect(() => Reflect.apply(Array.prototype.at, array, [1n])).toThrow(TypeError);
  });
});

describe('structuredClone DTO fallback', () => {
  it('clones real formula stats, frozen spark commands and visual cue shapes', () => {
    const inferno = createInfernoActor('shield', 'glyph', [1, 2]);
    const colosseum = createColosseumActor('beam_crystal', 'crystal', [3, 4]);
    const sparks = generateSparkVolley({ source: [30, 50], player: [30, 44], random: () => 0.5 });
    const infernoCue: EncounterVisualCue = {
      animations: [{ actorId: 'glyph', clipId: 'idle', delayCycles: 0 }],
      projectiles: [],
      graphics: [{ spotAnimId: 659, target: { kind: 'tile', position: [30, 44] }, height: 0, delayCycles: 2 }],
    };
    const colosseumCue: ColosseumVisualCue = {
      animations: [],
      graphics: [{ spotAnimId: 1, position: [3, 4], delayCycles: 1 }],
      projectiles: [],
    };
    const data = { stats: [inferno.formulaStats, colosseum.formulaStats], sparks, infernoCue, colosseumCue };
    const expected = nativeClone(data);
    useCloneFallback();
    const clone = structuredClone(data);
    expect(clone).toEqual(expected);
    expect(clone.stats[0]).not.toBe(data.stats[0]);
    expect(clone.sparks[0].position).not.toBe(sparks[0].position);
    expect(Object.isFrozen(clone.sparks[0].position)).toBe(false);
  });

  it('preserves simulation/tutorial histories and replay aliases across object and Map graphs', () => {
    const position: Coordinate = [30, 40];
    const history = new Map([[1, position]]);
    const state: Pick<SimulationState, 'currentTick' | 'playerPosition' | 'playerHistory' | 'primaryNpcHistory'> = {
      currentTick: 1,
      playerPosition: position,
      playerHistory: history,
      primaryNpcHistory: history,
    };
    const viewportState = { kind: 'orbit3d', target: { x: 1, y: 2, z: 3 }, yawDeg: 180, pitchDeg: -45, fovScale: 512 };
    const replay = {
      frames: [{ state, uiState: { activeGamePanelTab: 'inventory' }, viewportState, dpsProjection: null, events: [] }],
      cursorSamples: [{ tMs: 0, x: 1, y: 2, insideFrame: true, viewportState }],
      damageHistory: [{ tick: 1, playerPosition: position, effectiveDamage: 0 }],
      runConfig: { encounter: { kind: 'zuk', seeds: { seed: 42 } }, completionOwnership: 'encounter-owned' },
    };
    const expected = nativeClone(replay);
    useCloneFallback();
    const clone = structuredClone(replay);
    expect(clone).toEqual(expected);
    expect(clone.frames[0].state.playerHistory).toBeInstanceOf(Map);
    expect(clone.frames[0].state.playerHistory).not.toBe(history);
    expect(clone.frames[0].state.playerHistory).toBe(clone.frames[0].state.primaryNpcHistory);
    expect(clone.frames[0].state.playerHistory.get(1)).toBe(clone.frames[0].state.playerPosition);
    expect(clone.frames[0].viewportState).toBe(clone.cursorSamples[0].viewportState);
  });

  it('supports cycles, Map object keys, sparse arrays and non-JSON primitives', () => {
    useCloneFallback();
    // biome-ignore lint/suspicious/noSparseArray: the clone must preserve holes.
    const value = { map: new Map<unknown, unknown>(), array: [, undefined, NaN, Infinity, -0, 1n] };
    value.map.set(value, value.map);
    const clone = structuredClone(value);
    expect(clone.map.get(clone)).toBe(clone.map);
    expect(0 in clone.array).toBe(false);
    expect(1 in clone.array).toBe(true);
    expect(clone.array).toEqual(value.array);
    expect(structuredClone(undefined)).toBeUndefined();
  });

  it('drops prototypes, hidden/symbol properties and descriptors without treating __proto__ as a setter', () => {
    useCloneFallback();
    class Data {
      nested = Object.freeze({ value: 3 });
      method() {}
    }
    const input = Object.assign(new Data(), { [Symbol('ignored')]: () => {} });
    Object.defineProperty(input, 'hidden', { value: () => {} });
    Object.defineProperty(input, 'computed', { get: () => ({ value: 4 }), enumerable: true });
    Object.defineProperty(input, '__proto__', { value: { safe: true }, enumerable: true });
    const clone = structuredClone(input);
    expect(Object.getPrototypeOf(clone)).toBe(Object.prototype);
    expect(Reflect.ownKeys(clone)).toEqual(['nested', 'computed', '__proto__']);
    expect(Object.getOwnPropertyDescriptor(clone, 'nested')).toEqual({
      value: { value: 3 },
      writable: true,
      configurable: true,
      enumerable: true,
    });
    expect(Object.getOwnPropertyDescriptor(clone, '__proto__')?.value).toEqual({ safe: true });
    expect(Object.isFrozen(clone.nested)).toBe(false);
  });

  it('rejects function/symbol values and out-of-contract host types instead of losing data silently', () => {
    useCloneFallback();
    for (const value of [() => {}, Symbol('x'), { nested: () => {} }, new WeakMap(), new Date(), new Uint8Array(1)]) {
      expect(() => structuredClone(value)).toThrow(expect.objectContaining({ name: 'DataCloneError' }));
    }
    expect(() => structuredClone({}, { transfer: [new ArrayBuffer(1)] })).toThrow(
      expect.objectContaining({ name: 'DataCloneError' }),
    );
  });
});

describe('crypto.randomUUID fallback', () => {
  it('uses cryptographic entropy and sets the UUID v4 version and variant bits', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(255));
    vi.stubGlobal('crypto', { getRandomValues });
    installPolyfills();
    expect(crypto.randomUUID()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
  });

  it('does not invent an insecure replacement when crypto entropy is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => installPolyfills()).not.toThrow();
    expect(globalThis.crypto).toBeUndefined();
    vi.stubGlobal('crypto', {});
    installPolyfills();
    expect(crypto.randomUUID).toBeUndefined();
  });
});
