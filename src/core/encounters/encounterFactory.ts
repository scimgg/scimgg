import type { MechanicsConfig } from '../../types/simulation';
import type { EncounterCollisionSpec } from '../arena/collisionSpec';
import type { EncounterMapSquareOffsets } from './mapFootprint';
import type { EncounterSetupNoteRule } from './setupNotes';
import type { Encounter, EncounterVariant } from './types';

type EncounterFactory = (config?: Record<string, unknown>) => Encounter;

export interface EncounterDescriptor {
  kind: string;
  displayName: string;
  description: string;
  /** The origin map square: simulation tile (0, 0) is its south-west corner. */
  mapSquare: { x: number; y: number };
  /**
   * Every map square the encounter loads, relative to {@link mapSquare}; omitted means the origin
   * square alone. Each is an arena square unless marked `sceneryOnly`. Read it through
   * `resolveEncounterMapFootprint` (`./mapFootprint`), which splits the roles; see
   * docs/architecture/encounters.md (Map footprint).
   */
  mapSquareOffsets?: EncounterMapSquareOffsets;
  playerStart: [number, number];
  /**
   * Arena collision spec. Defaults to `{ mode: 'auto' }` when omitted: collision
   * is auto-derived from {@link EncounterDescriptor.mapSquare} (walls, pillars,
   * and any clipping loc block via their cache clipType). Declare `dynamicLocs`
   * for packet-spawned locs absent from the map data, or `mode: 'custom'` to
   * supply a hand-built config via `Encounter.getArenaConfig()`.
   */
  collision?: EncounterCollisionSpec;
  /**
   * Whether this encounter loads the surrounding map-square loc data
   * (walls, pillars, scenery, interactive objects). When `true`, the cache
   * manager fetches the loc archive for {@link EncounterDescriptor.mapSquare}
   * and the renderer waits for it before signaling scene-ready.
   */
  loadsMapLocs?: boolean;
  variants?: EncounterVariant[];
  variantLabel?: string;
  /** Optional tiered modifiers the player can switch on in the encounter panel before a run. */
  readonly modifiers?: readonly EncounterModifierDefinition[];
  /** Advisory rules that inspect the saved loadout and selected modifiers before a run. */
  readonly setupNotes?: readonly EncounterSetupNoteRule[];
  /**
   * The modifiers a run of `mechanics` starts with while the player has saved no selection of their
   * own (any saved one, an empty one included, replaces it). Omitted: none. A function of the run
   * setup because a default can follow it (a Fortis Colosseum start wave's).
   */
  readonly defaultModifiers?: (mechanics: Readonly<Partial<MechanicsConfig>>) => EncounterModifierSelection;
  isWorkInProgress?: boolean;
  readonly victory?: EncounterVictoryDescriptor;
}

/** One of an encounter's optional run modifiers, offered at one or three tiers of severity. */
export interface EncounterModifierDefinition {
  readonly id: string;
  readonly name: string;
  /** Public asset path of the modifier's icon; omitted leaves its slot empty. */
  readonly icon?: string;
  /** What the modifier does, shown while it is off. */
  readonly summary: string;
  /** Each tier's effect, tier I first. A single entry means the modifier is only on or off. */
  readonly tiers: readonly [string] | readonly [string, string, string];
}

export type EncounterModifierTier = 1 | 2 | 3;

/** Selected tier per modifier id; an absent id is off. */
export type EncounterModifierSelection = Readonly<Record<string, EncounterModifierTier>>;

/** Saved picker preferences may outlive an offered modifier. Keep only currently valid choices. */
export function filterModifierSelection(
  definitions: readonly EncounterModifierDefinition[] | undefined,
  selection: EncounterModifierSelection = {},
): EncounterModifierSelection {
  return Object.fromEntries(
    (definitions ?? []).flatMap(({ id, tiers }) => {
      const tier = selection[id];
      return (tier === 1 || tier === 2 || tier === 3) && tier <= tiers.length ? [[id, tier]] : [];
    }),
  );
}

export type EncounterVictoryAccent = 'gold' | 'blood';

export type EncounterVictoryDescriptor = {
  readonly eyebrow: string;
  readonly title: string;
  readonly narrative: string;
  readonly accent: EncounterVictoryAccent;
};

export class EncounterRegistry {
  private factories = new Map<string, EncounterFactory>();
  private descriptors = new Map<string, EncounterDescriptor>();

  register(kind: string, factory: EncounterFactory, descriptor?: EncounterDescriptor): void {
    if (this.factories.has(kind)) throw new DuplicateEncounterKindError(kind);
    if (descriptor && descriptor.kind !== kind) {
      throw new EncounterDescriptorKindMismatchError(kind, descriptor.kind);
    }
    this.factories.set(kind, factory);
    if (descriptor) {
      this.descriptors.set(kind, descriptor);
    }
  }

  create(kind: string, config?: Record<string, unknown>): Encounter {
    const factory = this.factories.get(kind);
    if (!factory) {
      const kinds = this.getRegisteredKinds();
      const registeredKinds = kinds.length > 0 ? kinds.join(', ') : '(none)';
      throw new Error(`Unknown encounter kind: '${kind}'. Registered kinds: ${registeredKinds}`);
    }
    return factory(config);
  }

  getRegisteredKinds(): string[] {
    return Array.from(this.factories.keys());
  }

  hasKind(kind: string): boolean {
    return this.factories.has(kind);
  }

  getDescriptor(kind: string): EncounterDescriptor | undefined {
    return this.descriptors.get(kind);
  }

  /**
   * Useful when the active encounterKind belongs to an unregistered variant
   * (e.g. an unimplemented contract) whose parent descriptor holds the variants list.
   */
  getDescriptorForKind(kind: string): EncounterDescriptor | undefined {
    const direct = this.descriptors.get(kind);
    if (direct) return direct;
    for (const desc of this.descriptors.values()) {
      if (desc.variants?.some((v) => v.encounterKind === kind)) {
        return desc;
      }
    }
    return undefined;
  }
}

export class DuplicateEncounterKindError extends Error {
  constructor(readonly kind: string) {
    super(`Duplicate encounter kind: '${kind}'`);
    this.name = 'DuplicateEncounterKindError';
  }
}

export class EncounterDescriptorKindMismatchError extends Error {
  constructor(
    readonly kind: string,
    readonly descriptorKind: string,
  ) {
    super(`Encounter '${kind}' has a mismatched descriptor kind '${descriptorKind}'`);
    this.name = 'EncounterDescriptorKindMismatchError';
  }
}

/**
 * The POPULATED singleton lives in `src/encounters/registry.ts` — its header is the
 * canonical statement of why it must not move back here.
 */
