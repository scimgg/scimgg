import { resolveEncounterMapFootprint } from '../../core/encounters/mapFootprint';
import { encounterRegistry } from '../../encounters/registry';
import type { AuthoredEncounterRenderConfig, EncounterRenderConfig } from './encounterRenderConfig';

/**
 * `config` with the map squares of `encounterKind`'s core descriptor (a variant kind's parent's), or
 * `config` unchanged for a kind with no descriptor.
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
