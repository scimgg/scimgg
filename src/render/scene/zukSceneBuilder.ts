import { configureEncounterScene } from './encounterSceneBuilder';
import { InfernoSceneCompositor } from './InfernoSceneCompositor';
import type { SceneBuilderOptions } from './sceneBuilderFactory';
import type { SceneBuilder } from './types';

/** The Inferno's scene, waves 1-69. */
export function createZukSceneBuilder(options: Partial<SceneBuilderOptions>): SceneBuilder {
  return configureEncounterScene(new InfernoSceneCompositor(), options);
}
