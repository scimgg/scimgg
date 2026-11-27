import type { EventAudioPlayer, FrameSoundTracker } from '../../audio';
import type { CacheManager } from '../../cache/CacheManager';
import { encounterPresentationModuleForKind } from '../../encounters/presentationModules';
import { encounterRegistry } from '../../encounters/registry';
import { type EncounterRenderConfig, getEncounterRenderConfig } from './encounterRenderConfig';
import { configureEncounterScene } from './encounterSceneBuilder';
import { SceneCompositor } from './SceneCompositor';
import type { SceneBuilderLike } from './types';

export interface SceneBuilderOptions {
  cacheManager: CacheManager;
  eventAudioPlayer?: EventAudioPlayer;
  frameSoundTracker?: FrameSoundTracker;
  encounterRenderConfig?: EncounterRenderConfig;
}

/**
 * A presentation module's own scene: it chooses the compositor and configures it from `options`,
 * whose render config {@link createSceneBuilderForKind} has already resolved.
 */
export type SceneBuilderFactory = (options: SceneBuilderOptions) => SceneBuilderLike;

/**
 * The scene for a kind the encounter registry runs: its base kind's presentation module's own scene
 * builder, else the common `SceneCompositor`, configured with the caller's render config or else
 * the kind's resolved one. Throws for any other name (unknown, withheld or retired), which has no
 * encounter to present.
 */
export function createSceneBuilderForKind(kind: string, options: SceneBuilderOptions): SceneBuilderLike {
  if (!encounterRegistry.hasKind(kind)) throw new Error(`Unknown encounter kind: "${kind}"`);
  const resolved: SceneBuilderOptions = {
    ...options,
    encounterRenderConfig: options.encounterRenderConfig ?? getEncounterRenderConfig(kind),
  };
  const own = encounterPresentationModuleForKind(kind)?.sceneBuilder;
  return own ? own(resolved) : configureEncounterScene(new SceneCompositor(), resolved);
}
