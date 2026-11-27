import type { SceneCompositor } from './SceneCompositor';
import type { SceneBuilderOptions } from './sceneBuilderFactory';

/**
 * Hands an encounter's compositor what every encounter scene needs: the render config
 * `createSceneBuilderForKind` resolved, event audio, frame audio and the ground-item cache.
 */
export function configureEncounterScene<T extends SceneCompositor>(
  compositor: T,
  options: Partial<SceneBuilderOptions>,
): T {
  compositor.setEncounterRenderConfig(options.encounterRenderConfig);
  compositor.setEventAudioPlayer(options.eventAudioPlayer ?? null);
  compositor.setFrameSoundTracker(options.frameSoundTracker ?? null);
  compositor.setGroundItemLoaderSource(options.cacheManager ?? null);
  return compositor;
}
