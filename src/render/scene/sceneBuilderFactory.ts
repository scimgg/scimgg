import type { EventAudioPlayer, FrameSoundTracker } from '../../audio';
import type { CacheManager } from '../../cache/CacheManager';
import { ENCOUNTER_CORE_MODULES, encounterKindsOf } from '../../encounters/modules';
import { ENCOUNTER_PRESENTATION_MODULES, type EncounterPresentationModule } from '../../encounters/presentationModules';
import { ENCOUNTER_RENDER_CONFIGS } from '../../encounters/renderConfigs';
import type { EncounterRenderConfig } from './encounterRenderConfig';
import { createEncounterSceneBuilder } from './encounterSceneBuilder';
import type { SceneBuilderLike } from './types';

export interface SceneBuilderOptions {
  cacheManager: CacheManager;
  eventAudioPlayer?: EventAudioPlayer;
  frameSoundTracker?: FrameSoundTracker;
  encounterRenderConfig?: EncounterRenderConfig;
}

export type SceneBuilderFactory = (options: SceneBuilderOptions) => SceneBuilderLike;

export class SceneBuilderRegistry {
  private factories = new Map<string, SceneBuilderFactory>();

  register(kind: string, factory: SceneBuilderFactory): void {
    this.factories.set(kind, factory);
  }

  create(kind: string, options: SceneBuilderOptions): SceneBuilderLike {
    const factory = this.factories.get(kind);
    if (!factory) {
      throw new Error(`Unknown scene builder kind: "${kind}". Registered: [${[...this.factories.keys()].join(', ')}]`);
    }
    return factory(options);
  }

  hasKind(kind: string): boolean {
    return this.factories.has(kind);
  }
}

export const sceneBuilderRegistry = new SceneBuilderRegistry();

/**
 * Register a scene builder for every encounter kind in the presentation manifest, expanding
 * variant kinds from the core manifest so Yama's contracts reuse the base builder without
 * being listed again.
 */
for (const module of ENCOUNTER_PRESENTATION_MODULES) {
  const core = ENCOUNTER_CORE_MODULES.find((entry) => entry.kind === module.kind);
  for (const kind of core ? encounterKindsOf(core) : [module.kind]) {
    sceneBuilderRegistry.register(kind, sceneBuilderFactoryFor(module));
  }
}

/**
 * The module's own scene builder, else the common scene with the render config registered for the
 * module's kind, resolved when a scene is built rather than while the manifests load.
 */
export function sceneBuilderFactoryFor(
  module: Pick<EncounterPresentationModule, 'kind' | 'sceneBuilder'>,
): SceneBuilderFactory {
  return (
    module.sceneBuilder ??
    ((options) => createEncounterSceneBuilder(module.kind, ENCOUNTER_RENDER_CONFIGS.get(module.kind), options))
  );
}
