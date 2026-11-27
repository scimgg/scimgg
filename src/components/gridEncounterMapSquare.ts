import { type EncounterMapFootprint, resolveEncounterMapFootprint } from '../core/encounters/mapFootprint';
import { encounterRegistry } from '../encounters/registry';

/**
 * The displayed encounter's map footprint, a variant kind resolved through its parent descriptor.
 * Undefined for a kind with no descriptor.
 */
export function getEncounterMapFootprint(encounterKind: string): EncounterMapFootprint | undefined {
  const descriptor = encounterRegistry.getDescriptorForKind(encounterKind);
  return descriptor ? resolveEncounterMapFootprint(descriptor) : undefined;
}
