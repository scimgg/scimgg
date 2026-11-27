import { isAppleTouchDevice } from '../../util/mobileDetection';
import { ColosseumSceneCompositor } from './ColosseumSceneCompositor';
import { configureEncounterScene } from './encounterSceneBuilder';
import type { SceneBuilderOptions } from './sceneBuilderFactory';
import type { SceneBuilder } from './types';

export function createSolHereditSceneBuilder(options: Partial<SceneBuilderOptions>): SceneBuilder {
  // iOS only, as mitigations for Safari page crashes under Sol's heaviest effects (cause unknown):
  // skip the puffs no camera can see and the beam parts that rasterize nothing, and draw runs of the
  // rest as single instanced draws. None changes what is on screen. Desktop draws every part singly.
  const ios = typeof navigator !== 'undefined' && isAppleTouchDevice(navigator);
  const compositor = new ColosseumSceneCompositor({
    cullSolMeleeOutsideView: ios,
    batchSolEffects: ios,
    skipZeroAreaBeamParts: ios,
  });
  return configureEncounterScene(compositor, options);
}
