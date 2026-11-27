/**
 * The pure encounter identity catalog: every kind the product knows, its variant
 * relationship, its public URL slug, and whether it is registered in production.
 *
 * This is the ONE place a kind's identity lives. The URL slug table derives from it
 * directly (`./slugs.ts`); the simulation registry ({@link ./registry}), the
 * presentation manifest ({@link ./presentationModules}) and the
 * lobby metadata are maintained by hand and PINNED to it by `encounterModules.test.ts` —
 * flipping an entry here does not edit them, it turns every leftover reference into a
 * test failure.
 *
 * Pure data: importable from core, Node scripts, and the browser alike.
 * Runtime imports of encounter implementations, render, or UI code are forbidden
 * here — `import type` is the ceiling.
 */
import type { YamaEncounterKind } from './yamaP3/contracts';

export interface EncounterCatalogEntry {
  /** Base encounter kind. Variants list their kinds in {@link variantKinds}. */
  readonly kind: string;
  /** Variant kinds owned by this base kind (Yama's contracts). Empty when the fight has none. */
  readonly variantKinds: readonly string[];
  /**
   * URL slug for the base kind's route.
   * `null` for surfaces that must never be publicly routed (the lobby).
   */
  readonly slug: string | null;
  /**
   * Whether this kind ships in the production manifests. `false` removes it from the
   * derived slug table directly and makes any remaining registry, presentation,
   * or lobby reference a test failure. Flipping it to `true` without adding
   * the manifest entries fails those same tests rather than shipping a dead portal.
   */
  readonly registered: boolean;
  /**
   * Alias kinds that resolve to this encounter (Zuk is wave 69 of the Inferno). A retired kind has
   * no factory and is never live: fresh entry, saved loadouts and routes resolve it here
   * ({@link canonicalEncounterKind}); where it enters is the owning module's business
   * (`EncounterCoreModule.retiredEntries`). Recordings of a retired kind play back in this
   * encounter's scene.
   */
  readonly retiredKinds?: readonly RetiredEncounterKind[];
}

export interface RetiredEncounterKind {
  readonly kind: string;
  /** Its public slug, accepted on entry so links to it resolve to the owning encounter. */
  readonly slug: string;
}

const YAMA_VARIANT_KINDS = [
  'yama_p3_divine',
  'yama_p3_forfeit_breath',
  'yama_p3_sensory',
  'yama_p3_bloodied',
  'yama_p3_glyphic',
] as const satisfies readonly YamaEncounterKind[];

export const ENCOUNTER_CATALOG: readonly EncounterCatalogEntry[] = [
  { kind: 'yama_p3', variantKinds: YAMA_VARIANT_KINDS, slug: 'yama', registered: true },
  { kind: 'lobby', variantKinds: [], slug: null, registered: true },
  { kind: 'sol_heredit', variantKinds: [], slug: 'sol-heredit', registered: true },
  {
    kind: 'inferno',
    variantKinds: [],
    slug: 'inferno',
    registered: true,
    retiredKinds: [{ kind: 'zuk', slug: 'zuk' }],
  },
  { kind: 'zulrah', variantKinds: [], slug: 'zulrah', registered: true },
];

const ENTRY_BY_KIND: ReadonlyMap<string, EncounterCatalogEntry> = new Map(
  ENCOUNTER_CATALOG.flatMap((entry) => [entry.kind, ...entry.variantKinds].map((kind) => [kind, entry] as const)),
);

const CANONICAL_BY_RETIRED_KIND: ReadonlyMap<string, string> = new Map(
  ENCOUNTER_CATALOG.flatMap((entry) =>
    (entry.retiredKinds ?? []).map((retired) => [retired.kind, entry.kind] as const),
  ),
);

/** Every retired kind with the live kind that owns it. */
export const RETIRED_ENCOUNTER_KINDS: readonly { readonly retired: RetiredEncounterKind; readonly kind: string }[] =
  ENCOUNTER_CATALOG.flatMap((entry) => (entry.retiredKinds ?? []).map((retired) => ({ retired, kind: entry.kind })));

/** The live kind a retired kind belongs to (`zuk` → `inferno`); any other kind unchanged. */
export function canonicalEncounterKind(kind: string): string {
  return CANONICAL_BY_RETIRED_KIND.get(kind) ?? kind;
}

/**
 * Folds each retired kind's entry of a persisted per-encounter map into the kind that owns it
 * and drops the retired key. `merge(owned, retired)` combines the two; where both set the same
 * thing the retired kind's value should win, the policy saved loadouts and mechanics follow. Pass
 * an already-normalized map so the result never depends on the stored property order.
 * Idempotent: the result has no retired keys left, so a second pass reports nothing moved.
 */
export function consolidateRetiredEncounterKinds<T>(
  map: Readonly<Record<string, T>>,
  merge: (owned: T | undefined, retired: T) => T,
): { readonly map: Record<string, T>; readonly consolidated: boolean } {
  const next: Record<string, T> = { ...map };
  let consolidated = false;
  for (const { retired, kind } of RETIRED_ENCOUNTER_KINDS) {
    const saved = next[retired.kind];
    if (saved === undefined) continue;
    next[kind] = merge(next[kind], saved);
    delete next[retired.kind];
    consolidated = true;
  }
  return { map: next, consolidated };
}

export function isRetiredEncounterKind(kind: string): boolean {
  return CANONICAL_BY_RETIRED_KIND.has(kind);
}

/**
 * The kind that owns `kind`: a variant resolves to its parent, a retired kind to the encounter it
 * is now part of, a base encounter to itself.
 *
 * A variant is the same fight in the same arena, so anything keyed by encounter (tile packs,
 * training courses, encounter commands) should answer for the parent rather than miss on the
 * variant's own kind. Zuk's practice commands keep their `encounter: 'zuk'` namespace and reach the
 * Inferno through this.
 */
export function baseEncounterKind(kind: string): string {
  const canonical = canonicalEncounterKind(kind);
  return ENTRY_BY_KIND.get(canonical)?.kind ?? canonical;
}

/** Every kind the production simulation registry must carry: registered bases and their variants. */
export const REGISTERED_CATALOG_KINDS: readonly string[] = ENCOUNTER_CATALOG.filter(
  (entry) => entry.registered,
).flatMap((entry) => [entry.kind, ...entry.variantKinds]);
