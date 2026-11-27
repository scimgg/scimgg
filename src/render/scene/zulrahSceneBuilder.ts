import { ZULRAH_RENDER_CONFIG } from '../../encounters/zulrah/renderConfig';
import { InfernoSceneCompositor } from './InfernoSceneCompositor';
import type { SceneBuilderOptions } from './sceneBuilderFactory';
import type { SceneBuilder } from './types';

/**
 * Zulrah's shrine. Reuses the Inferno compositor: its `inferno_visual` animations and projectiles are
 * generic, and its Zuk-specific parts all check for the Inferno snapshot first.
 */
export function createZulrahSceneBuilder(options?: Partial<SceneBuilderOptions>): SceneBuilder {
  const compositor = new InfernoSceneCompositor();
  compositor.setEncounterRenderConfig(options?.encounterRenderConfig ?? ZULRAH_RENDER_CONFIG);
  compositor.setEventAudioPlayer(options?.eventAudioPlayer ?? null);
  compositor.setFrameSoundTracker(options?.frameSoundTracker ?? null);
  compositor.setGroundItemLoaderSource(options?.cacheManager ?? null);
  return compositor;
}
