import { useEffect, useRef } from 'react';
import type { EncounterRegistry } from '../core/encounters/encounterFactory';
import { canonicalEncounterKind } from '../encounters/catalog';
import { resolveLegacySlugEntry } from '../encounters/modules';
import {
  KIND_TO_SLUG,
  RETIRED_SLUG_TO_KIND,
  SLUG_TO_KIND,
  slugToVariantId,
  variantIdToSlug,
} from '../encounters/slugs';
import type { MechanicsConfig } from '../types/simulation';

export type SceneState =
  | { kind: 'lobby' }
  | { kind: 'loading'; targetEncounter: string }
  | { kind: 'encounter'; encounterKind: string };

function getPathSegments(): string[] {
  return window.location.pathname.replace(/^\//, '').replace(/\/$/, '').split('/').filter(Boolean);
}

/**
 * Rebuild the URL's query string for a routing-driven replaceState: the new route's own
 * `routeQuery` (see {@link useRouting}), then any params we care about from the current URL.
 *
 * Only `?popout=1` needs to survive navigation — without this,
 * the first state-to-URL sync strips the popout flag from the URL and
 * refreshing/bookmarking the popup window loses popout mode (since
 * IS_POPOUT_WINDOW is re-evaluated from the URL on reload).
 */
export function preservedQueryString(routeQuery = ''): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  const parts = [routeQuery, params.get('popout') === '1' ? 'popout=1' : ''].filter(Boolean);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

function paramName(part: string): string {
  const name = part.split('=', 1)[0];
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** The query a route's own state puts in the address beside its path (the Inferno's setup mirror). */
export interface RouteQuery {
  /** Every parameter name the query may write: these belong to it, wherever they stand. */
  readonly params: readonly string[];
  /** The query now, raw and without `?`, using only `params`; '' for none. */
  readonly query: string;
}

const NO_ROUTE_QUERY: RouteQuery = { params: [], query: '' };

/**
 * `search` with `routeQuery`'s parameters replaced by its query (first), and every other param kept
 * as written. Parts are compared by name and never re-encoded, so a route query's raw brackets stay
 * raw.
 */
export function replaceRouteQuery(search: string, routeQuery: RouteQuery): string {
  const owned = new Set(routeQuery.params);
  const rest = search
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => part !== '' && !owned.has(paramName(part)));
  const parts = [routeQuery.query, ...rest].filter(Boolean);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/** What a path enters: a kind, and for a former slug the run setup it stands for. */
interface RouteTarget {
  readonly kind: string;
  readonly mechanics?: Readonly<Partial<MechanicsConfig>>;
}

/**
 * Resolve a full URL path to an encounter kind.
 *
 * Supports:
 *   /yama                    → yama_p3 (base fight)
 *   /yama/forfeit-breath     → yama_p3_forfeit_breath
 *   /yama/glyphic-attenuation → yama_p3_glyphic
 *   /zuk                     → zuk (retired: entering it starts the Inferno at wave 69, and the
 *                              state-to-URL sync then rewrites the address to /inferno/)
 *   /sol-heredit             → sol_heredit at wave 12 (a former slug: the sync then rewrites the
 *                              address to /colosseum/)
 */
function resolvePathToTarget(segments: string[], encounterRegistry: EncounterRegistry): RouteTarget | null {
  if (segments.length === 0) return null;

  const baseSlug = segments[0];
  const retiredKind = RETIRED_SLUG_TO_KIND.get(baseSlug);
  if (retiredKind !== undefined) return { kind: retiredKind };
  const legacyEntry = resolveLegacySlugEntry(baseSlug);
  if (legacyEntry !== undefined) return legacyEntry;
  const baseKind = SLUG_TO_KIND.get(baseSlug) ?? baseSlug;
  const desc = encounterRegistry.getDescriptor(baseKind);

  if (!desc || baseKind === 'lobby') return null;

  if (segments.length === 1) return { kind: baseKind };

  const variantSlug = segments[1];
  const variantId = slugToVariantId(variantSlug);
  const variant = desc.variants?.find((v) => v.id === variantId);

  if (variant) return { kind: variant.encounterKind };

  return { kind: baseKind };
}

/**
 * Build the URL path for an encounter kind.
 *
 * Contract variants get a sub-path: /yama/forfeit-breath
 * Base encounters stay flat: /yama
 */
function resolveKindToPath(encounterKind: string, encounterRegistry: EncounterRegistry): string {
  const desc = encounterRegistry.getDescriptorForKind(encounterKind);
  const baseKind = desc?.kind ?? encounterKind;
  const baseSlug = KIND_TO_SLUG.get(baseKind) ?? baseKind;

  if (encounterKind === baseKind) return baseSlug;

  const variant = desc?.variants?.find((v) => v.encounterKind === encounterKind);
  if (variant) {
    // Don't add a sub-path for the "no contract" / base variant
    if (variant.encounterKind === baseKind) return baseSlug;
    return `${baseSlug}/${variantIdToSlug(variant.id)}`;
  }

  return baseSlug;
}

/**
 * Keeps the address and the scene in step. `routeQuery` is the query the current route's state puts
 * in the address beside the path (the Inferno's setup mirror): written first, ahead of a kept
 * `popout=1`, when the path changes, and replaced in place, other params kept, while it stays.
 *
 * `enabled: false` leaves the address alone in both directions. The UI harness passes it: its page
 * (`/ui-harness.html?…`) is not a route, and rewriting it would make a reload boot the full app.
 */
export function useRouting(
  sceneState: SceneState,
  /** `mechanics`, a former slug's run setup, are saved over the saved setup and started with. */
  enterEncounter: (kind: string, mechanics?: Readonly<Partial<MechanicsConfig>>) => void,
  enterLobby: () => void,
  encounterRegistry: EncounterRegistry,
  routeQuery: RouteQuery = NO_ROUTE_QUERY,
  enabled = true,
) {
  const isNavigatingRef = useRef(false);
  const hasInitializedRef = useRef(false);

  // Sync state -> URL path
  // Skips first render so the URL->state effect can process the initial URL
  // before this effect would clear it (e.g. navigating directly to /yama).
  const { params: routeParams, query: routeQueryString } = routeQuery;
  useEffect(() => {
    if (!enabled || !hasInitializedRef.current) return;

    let currentSlug = '';

    if (sceneState.kind === 'lobby') {
      currentSlug = '';
    } else if (sceneState.kind === 'encounter') {
      currentSlug = resolveKindToPath(sceneState.encounterKind, encounterRegistry);
    } else if (sceneState.kind === 'loading') {
      currentSlug = resolveKindToPath(sceneState.targetEncounter, encounterRegistry);
    }

    const pathSlug = getPathSegments().join('/');

    if (pathSlug === currentSlug) {
      // The same route: only its own query's params change, in place. Safe mid-navigation too, as
      // the path already agrees with the scene.
      if (routeParams.length === 0) return;
      const { pathname, search, hash } = window.location;
      const next = replaceRouteQuery(search, { params: routeParams, query: routeQueryString });
      if (next !== search) window.history.replaceState(window.history.state, '', `${pathname}${next}${hash}`);
      return;
    }
    // A scene the URL is still navigating to: the URL leads, so leave it.
    if (isNavigatingRef.current) return;
    // Always the trailing-slash form, so one route has one address. `getPathSegments()`
    // strips the trailing slash, so the comparison against `pathSlug` above is unaffected.
    const path = currentSlug ? `/${currentSlug}/` : '/';
    window.history.replaceState(null, '', `${path}${preservedQueryString(routeQueryString)}`);
  }, [enabled, sceneState, encounterRegistry, routeParams, routeQueryString]);

  // Sync URL path -> state
  useEffect(() => {
    if (!enabled) return;
    const handleNavigation = () => {
      const segments = getPathSegments();

      if (segments.length === 0 || segments[0] === 'lobby') {
        if (sceneState.kind !== 'lobby') {
          isNavigatingRef.current = true;
          enterLobby();
          setTimeout(() => {
            isNavigatingRef.current = false;
          }, 0);
        }
        return;
      }

      const target = resolvePathToTarget(segments, encounterRegistry);

      if (target && target.kind !== 'lobby') {
        const targetEncounter = target.kind;
        // Resolve current encounter to its base kind so contract variants
        // are recognized as belonging to the same base encounter as the URL.
        const currentKind =
          sceneState.kind === 'encounter'
            ? sceneState.encounterKind
            : sceneState.kind === 'loading'
              ? sceneState.targetEncounter
              : null;

        // Compared as owning kinds, so `/zuk` does not re-enter the Inferno it already entered while
        // the URL catches up (nor `/sol-heredit` the Colosseum).
        if (
          sceneState.kind === 'lobby' ||
          (currentKind !== null && canonicalEncounterKind(currentKind) !== canonicalEncounterKind(targetEncounter))
        ) {
          isNavigatingRef.current = true;
          if (target.mechanics) enterEncounter(targetEncounter, target.mechanics);
          else enterEncounter(targetEncounter);
          setTimeout(() => {
            isNavigatingRef.current = false;
          }, 0);
        }
      } else {
        window.history.replaceState(null, '', `/${preservedQueryString()}`);
        if (sceneState.kind !== 'lobby') {
          isNavigatingRef.current = true;
          enterLobby();
          setTimeout(() => {
            isNavigatingRef.current = false;
          }, 0);
        }
      }
    };

    handleNavigation(); // Process initial URL on mount
    hasInitializedRef.current = true;
    window.addEventListener('popstate', handleNavigation);

    return () => {
      window.removeEventListener('popstate', handleNavigation);
    };
  }, [enabled, enterEncounter, enterLobby, encounterRegistry, sceneState]);
}
