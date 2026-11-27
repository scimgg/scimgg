import { configureEncounterScene } from './encounterSceneBuilder';
import type { SceneBuilderOptions } from './sceneBuilderFactory';
import type { SceneBuilder } from './types';
import { YamaSceneCompositor } from './YamaSceneCompositor';

export function createYamaSceneBuilder(options: Partial<SceneBuilderOptions>): SceneBuilder {
  return configureEncounterScene(new YamaSceneCompositor(), options);
}
