import type { DukePracticeState, DukePracticeVisuals } from '../../encounters/dukePractice/snapshot';
import type { InfernoPublicState, InfernoVisuals } from '../../encounters/inferno/snapshot';
import type { SolHereditPublicState, SolHereditVisuals } from '../../encounters/solHeredit/snapshot';
import type { YamaEncounterKind } from '../../encounters/yamaP3/contracts';
import type { YamaPublicState, YamaVisuals } from '../../encounters/yamaP3/snapshot';
import type { ZukPublicState, ZukVisuals } from '../../encounters/zuk/snapshot';
import type { MechanicsConfig } from '../../types/simulation';
import type { WorldState } from '../WorldState';

/**
 * The single typed payload an encounter publishes each tick.
 *
 * The pair is produced by a single `Encounter.getSnapshot` call, so state and visuals always come
 * from the same tick, and `kind` narrows to a precise payload.
 *
 * Ownership: each encounter declares its own payload types next to itself; this module only
 * assembles the union. Yama's kinds share one variant because they share one payload shape.
 *
 * Payloads must be plain, readonly, `structuredClone`-safe data — no functions, class instances,
 * Maps or Sets. `ReplayRecorder` clones the whole simulation state every frame, and a snapshot is
 * a DTO, not a live object. Enforced by `encounterSnapshotCloneable.test.ts`.
 */
export type EncounterSnapshot =
  | { readonly kind: 'lobby'; readonly state: LobbyPublicState; readonly visuals: LobbyVisuals }
  | { readonly kind: YamaEncounterKind; readonly state: YamaPublicState; readonly visuals: YamaVisuals }
  /**
   * Recordings only: TzKal-Zuk was its own encounter before it became the Inferno's wave 69. No live
   * engine publishes this; read Zuk's state through {@link zukWaveState}, which answers for both.
   */
  | { readonly kind: 'zuk'; readonly state: ZukPublicState; readonly visuals: ZukVisuals }
  | {
      readonly kind: 'sol_heredit';
      readonly state: SolHereditPublicState;
      readonly visuals: SolHereditVisuals;
    }
  | {
      readonly kind: 'inferno';
      readonly state: InfernoPublicState;
      readonly visuals: InfernoVisuals;
    }
  | {
      readonly kind: 'duke_practice';
      readonly state: DukePracticeState;
      readonly visuals: DukePracticeVisuals;
    };

/** The lobby is a walkable scene with no fight state. */
export type LobbyPublicState = Record<string, never>;
export type LobbyVisuals = Record<string, never>;

export type YamaSnapshot = Extract<EncounterSnapshot, { kind: YamaEncounterKind }>;
export type ZukSnapshot = Extract<EncounterSnapshot, { kind: 'zuk' }>;
export type SolHereditSnapshot = Extract<EncounterSnapshot, { kind: 'sol_heredit' }>;
export type InfernoSnapshot = Extract<EncounterSnapshot, { kind: 'inferno' }>;

const YAMA_KINDS: ReadonlySet<string> = new Set<YamaEncounterKind>([
  'yama_p3',
  'yama_p3_divine',
  'yama_p3_forfeit_breath',
  'yama_p3_sensory',
  'yama_p3_bloodied',
  'yama_p3_glyphic',
]);

/**
 * Narrow to Yama, base fight or any contract. A `kind.startsWith('yama_p3')` test would also match
 * any future kind sharing that prefix.
 */
export function isYamaSnapshot(snapshot: EncounterSnapshot): snapshot is YamaSnapshot {
  return YAMA_KINDS.has(snapshot.kind);
}

/**
 * TzKal-Zuk's fight state while wave 69 is up, live (the Inferno's payload) or recorded under the
 * retired `zuk` kind; null on any other wave or encounter.
 */
export function zukWaveState(snapshot: EncounterSnapshot): ZukPublicState | null {
  if (snapshot.kind === 'zuk') return snapshot.state;
  if (snapshot.kind === 'inferno') return snapshot.state.zuk;
  return null;
}

export function isSolHereditSnapshot(snapshot: EncounterSnapshot): snapshot is SolHereditSnapshot {
  return snapshot.kind === 'sol_heredit';
}

export function isInfernoSnapshot(snapshot: EncounterSnapshot): snapshot is InfernoSnapshot {
  return snapshot.kind === 'inferno';
}

export interface EncounterSnapshotContext {
  readonly world: Readonly<WorldState>;
  readonly tick: number;
  /**
   * The whole config is passed so encounter-specific toggles (e.g. Yama's `fireballs`) stay out of
   * the shared `Encounter` interface.
   */
  readonly mechanics: Readonly<Partial<MechanicsConfig>>;
}
