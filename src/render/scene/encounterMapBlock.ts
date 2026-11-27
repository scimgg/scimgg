import { resolveEncounterMapFootprint } from '../../core/encounters/mapFootprint';
import { encounterRegistry } from '../../encounters/registry';
import type { AuthoredEncounterRenderConfig, EncounterRenderConfig } from './encounterRenderConfig';

/**
 * `config` with the map squares of `encounterKind`'s core descriptor (a variant kind's parent's), or
 * `config` unchanged for a kind with no descriptor. Kept out of `encounterRenderConfig.ts`, which
 * reads the presentation manifest, so a scene builder in that manifest can resolve its own default
 * config without an import cycle.
 */
export function withDescriptorMapBlock(
  config: AuthoredEncounterRenderConfig,
  encounterKind: string,
): EncounterRenderConfig {
  const descriptor = encounterRegistry.getDescriptorForKind(encounterKind);
  if (!descriptor) return config;
  const footprint = resolveEncounterMapFootprint(descriptor);
  return {
    ...config,
    terrainMapSquare: footprint.origin,
    mapSquareOffsets: footprint.sceneOffsets,
    arenaMapSquareOffsets: footprint.arenaOffsets,
  };
}
