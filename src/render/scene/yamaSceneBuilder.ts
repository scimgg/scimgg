import { YAMA_ENCOUNTER_RENDER_CONFIG } from '../../encounters/yamaP3/renderConfig';
import { withDescriptorMapBlock } from './encounterMapBlock';
import { configureEncounterScene } from './encounterSceneBuilder';
import type { SceneBuilderOptions } from './sceneBuilderFactory';
import type { SceneBuilder } from './types';
import { YamaSceneCompositor } from './YamaSceneCompositor';

export function createYamaSceneBuilder(options?: Partial<SceneBuilderOptions>): SceneBuilder {
  return configureEncounterScene(
    new YamaSceneCompositor(),
    options,
    withDescriptorMapBlock(YAMA_ENCOUNTER_RENDER_CONFIG, 'yama_p3'),
  );
}
