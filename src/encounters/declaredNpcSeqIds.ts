/**
 * Node-safe view of the encounter render configs, for build scripts (cache trimming, frame-sound
 * extraction) that must not import the presentation manifest's scene builders.
 */
import type { AuthoredEncounterRenderConfig } from '../render/scene/encounterRenderConfig';
import { INFERNO_RENDER_CONFIG } from './inferno/renderConfig';
import { SOL_HEREDIT_RENDER_CONFIG } from './solHeredit/renderConfig';
import { YAMA_ENCOUNTER_RENDER_CONFIG } from './yamaP3/renderConfig';

/**
 * Every render config in `ENCOUNTER_PRESENTATION_MODULES`, keyed by kind. Listed by hand because
 * that manifest is browser-only; `frameSoundManifest.test.ts` fails if the two drift.
 */
export const ENCOUNTER_RENDER_CONFIGS: ReadonlyMap<string, AuthoredEncounterRenderConfig> = new Map([
  ['yama_p3', YAMA_ENCOUNTER_RENDER_CONFIG],
  ['sol_heredit', SOL_HEREDIT_RENDER_CONFIG],
  ['inferno', INFERNO_RENDER_CONFIG],
]);

/**
 * Every NPC sequence the encounter render configs make the renderer play — the primary NPC's
 * death clip and each preloaded type's idle, spawn, death (default and per-cause) and attack
 * clips — with a label naming where it was declared. Cache-asset consumers (trimming,
 * frame-sound extraction) read this so an animation added to a render config cannot be missed by
 * a hand-kept list.
 */
export function collectDeclaredNpcSeqIds(
  configs: ReadonlyMap<string, AuthoredEncounterRenderConfig> = ENCOUNTER_RENDER_CONFIGS,
): Map<number, string> {
  const ids = new Map<number, string>();
  const add = (seqId: number | undefined, label: string): void => {
    if (seqId !== undefined && seqId >= 0 && !ids.has(seqId)) ids.set(seqId, label);
  };
  for (const [kind, config] of configs) {
    const primary = config.primaryNpc;
    if (primary) add(primary.deathSeqId, `${kind} npc ${primary.npcTypeId} death`);
    for (const npc of config.preloadNpcTypes ?? []) {
      const prefix = `${kind} npc ${npc.npcTypeId}`;
      add(npc.idleSeqId, `${prefix} idle`);
      add(npc.spawnSeqId, `${prefix} spawn`);
      add(npc.deathSeqId, `${prefix} death`);
      for (const [cause, clip] of Object.entries(npc.deathClips ?? {})) add(clip.seqId, `${prefix} death:${cause}`);
      for (const [clipId, seqId] of Object.entries(npc.attackClips ?? {})) add(seqId, `${prefix} ${clipId}`);
    }
  }
  return ids;
}

/**
 * Every spot animation the encounter render configs make the renderer draw — each config's
 * `spotAnimIds` and the primary NPC's death effect — with a label naming where it was declared.
 * Cache trimming roots these, and frame-sound extraction walks their sequences, so an effect added to
 * a render config keeps its model and its frame sounds in a trimmed build.
 */
export function collectDeclaredSpotAnimIds(
  configs: ReadonlyMap<string, AuthoredEncounterRenderConfig> = ENCOUNTER_RENDER_CONFIGS,
): Map<number, string> {
  const ids = new Map<number, string>();
  const add = (spotAnimId: number | undefined, label: string): void => {
    if (spotAnimId !== undefined && spotAnimId >= 0 && !ids.has(spotAnimId)) ids.set(spotAnimId, label);
  };
  for (const [kind, config] of configs) {
    add(config.primaryNpc?.deathSpotAnimId, `${kind} render config primaryNpc.deathSpotAnimId`);
    for (const id of config.spotAnimIds ?? []) add(id, `${kind} render config spotAnimIds`);
  }
  return ids;
}
