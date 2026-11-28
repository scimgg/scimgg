/**
 * Unregistered entries stay withheld even when they reserve a slug, so a kind
 * cannot gain a public route before it has a factory.
 *
 * The tables are Maps, not plain objects: they are indexed with path segments the user typed, and
 * an object lookup would answer `/toString` or `/constructor` with an inherited member.
 */
import { ENCOUNTER_CATALOG, RETIRED_ENCOUNTER_KINDS } from './catalog';

export const SLUG_TO_KIND: ReadonlyMap<string, string> = new Map(
  ENCOUNTER_CATALOG.flatMap((entry) =>
    entry.registered && entry.slug !== null ? [[entry.slug, entry.kind] as const] : [],
  ),
);

export const KIND_TO_SLUG: ReadonlyMap<string, string> = new Map(
  [...SLUG_TO_KIND].map(([slug, kind]) => [kind, slug] as const),
);

export function variantIdToSlug(id: string): string {
  return id.replace(/_/g, '-');
}

export function slugToVariantId(slug: string): string {
  return slug.replace(/-/g, '_');
}

/**
 * Public slugs of retired kinds (`/zuk`), accepted on entry: each names its retired kind,
 * which entering resolves to the encounter that owns it. Never generated as a canonical path.
 */
export const RETIRED_SLUG_TO_KIND: ReadonlyMap<string, string> = new Map(
  RETIRED_ENCOUNTER_KINDS.flatMap(({ retired }) =>
    retired.slug === undefined ? [] : [[retired.slug, retired.kind] as const],
  ),
);
