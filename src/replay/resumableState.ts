import { MAX_RESUMABLE_STATE_DIFFS } from '../core/replaySafety';
import type { SimulationState } from '../types/simulation';

/**
 * Fields a reconstruction is NOT expected to reproduce, because they are logs rather than state.
 *
 * `eventLog` accumulates every event since the run began and is never read back into the
 * simulation; the position histories are rolling render trails that the recorder empties before
 * it stores a frame (`snapshotStateForReplay`), so a recorded frame's copy is always empty while
 * a live engine's is not. Comparing either produces a guaranteed mismatch and would abort every
 * takeover. The renderer uses `crawlMovement` and `orbPreviousTile` for interpolation. Their
 * authoritative positions are compared separately. `usesVisualEvents` chooses how to play Duke’s
 * presentation and has no effect on the fight state.
 */
const IGNORED_STATE_KEYS: ReadonlySet<string> = new Set([
  'eventLog',
  'playerHistory',
  'primaryNpcHistory',
  'history',
  'crawlMovement',
  'orbPreviousTile',
  'usesVisualEvents',
]);

function normalize(value: unknown): unknown {
  if (value instanceof Map) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (IGNORED_STATE_KEYS.has(key)) continue;
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function collectDiffs(expected: unknown, actual: unknown, path: string, out: string[]): void {
  if (out.length >= MAX_RESUMABLE_STATE_DIFFS) return;
  if (Object.is(expected, actual)) return;

  const bothObjects =
    expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object';
  if (!bothObjects) {
    out.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    return;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    out.push(`${path}: array/object shape differs`);
    return;
  }
  const keys = new Set([
    ...Object.keys(expected as Record<string, unknown>),
    ...Object.keys(actual as Record<string, unknown>),
  ]);
  for (const key of keys) {
    collectDiffs(
      (expected as Record<string, unknown>)[key],
      (actual as Record<string, unknown>)[key],
      path === '' ? key : `${path}.${key}`,
      out,
    );
  }
}

/**
 * Empty means the reconstruction is exact and it is safe to hand the player the new engine. A
 * non-empty result must abort the takeover: the divergences that matter here (a few HP, a boss
 * phase, an attack cooldown, one tile of position) are invisible in the moment and lethal a tick
 * later, which is the entire failure mode takeover reconstruction exists to remove. Resuming on
 * "close enough" is what made it feel random.
 *
 * `expected` is the recorded state and `actual` the reconstruction.
 */
export function diffResumableState(expected: SimulationState, actual: SimulationState): string[] {
  const diffs: string[] = [];
  collectDiffs(normalize(expected), normalize(actual), '', diffs);
  return diffs;
}
