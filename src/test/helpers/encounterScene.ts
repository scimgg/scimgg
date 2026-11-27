import type { CacheManager } from '../../cache/CacheManager';
import type { SceneCompositor } from '../../render/scene/SceneCompositor';
import { createSceneBuilderForKind, type SceneBuilderOptions } from '../../render/scene/sceneBuilderFactory';

/** A cache manager before bootstrap, as a scene built at app start sees it: no ground-item loaders yet. */
export const UNBOOTSTRAPPED_CACHE_MANAGER = {
  getObjTypeLoader: () => null,
  getModelLoader: () => null,
} as unknown as CacheManager;

/**
 * `kind`'s scene as the app creates it (`createSceneBuilderForKind`), before the cache bootstraps,
 * checked to be a `compositor`.
 */
export function encounterScene<T extends SceneCompositor>(
  kind: string,
  compositor: abstract new (...args: never[]) => T,
  options: Partial<SceneBuilderOptions> = {},
): T {
  const scene = createSceneBuilderForKind(kind, { cacheManager: UNBOOTSTRAPPED_CACHE_MANAGER, ...options });
  if (!(scene instanceof compositor)) throw new Error(`${kind}: expected a ${compositor.name}`);
  return scene;
}
