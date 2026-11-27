import { withDescriptorMapBlock } from './encounterMapBlock';
import type { AuthoredEncounterRenderConfig, EncounterRenderConfig } from './encounterRenderConfig';
import { SceneCompositor } from './SceneCompositor';
import type { SceneBuilderOptions } from './sceneBuilderFactory';
import type { SceneBuilder } from './types';

/**
 * Hands an encounter's compositor what every encounter scene needs: its render config (the options'
 * own, else `defaultConfig`), event audio, frame audio and the ground-item cache.
 */
export function configureEncounterScene<T extends SceneCompositor>(
  compositor: T,
  options?: Partial<SceneBuilderOptions>,
  defaultConfig?: EncounterRenderConfig,
): T {
  compositor.setEncounterRenderConfig(options?.encounterRenderConfig ?? defaultConfig);
  compositor.setEventAudioPlayer(options?.eventAudioPlayer ?? null);
  compositor.setFrameSoundTracker(options?.frameSoundTracker ?? null);
  compositor.setGroundItemLoaderSource(options?.cacheManager ?? null);
  return compositor;
}

/**
 * The common scene, for an encounter whose presentation module names no scene builder of its own.
 * Without a config in `options` it takes `authoredConfig` with `kind`'s descriptor map squares, as
 * `getEncounterRenderConfig` resolves it.
 */
export function createEncounterSceneBuilder(
  kind: string,
  authoredConfig: AuthoredEncounterRenderConfig | undefined,
  options?: Partial<SceneBuilderOptions>,
): SceneBuilder {
  const defaultConfig = authoredConfig && withDescriptorMapBlock(authoredConfig, kind);
  return configureEncounterScene(new SceneCompositor(), options, defaultConfig);
}
