/**
 * The encounter render configs and the cache assets they declare. Node-safe, for build scripts
 * (cache trimming, frame-sound extraction) that must not import the presentation manifest's scene
 * builders.
 */
import type { NpcBaseSeqOverrides } from '../render/npc/npcBaseSeqIds';
import type { AuthoredEncounterRenderConfig } from '../render/scene/encounterRenderConfig';
import { INFERNO_RENDER_CONFIG } from './inferno/renderConfig';
import { LOBBY_BOSS_NPCS } from './lobby/metadata';
import { SOL_HEREDIT_RENDER_CONFIG } from './solHeredit/renderConfig';
import { YAMA_ENCOUNTER_RENDER_CONFIG } from './yamaP3/renderConfig';

/**
 * Each encounter's authored render config, keyed by base encounter kind (a variant reads its
 * parent's): the one place a config is registered. The browser's `getEncounterRenderConfig` and
 * scene lookup read it, as do the build scripts, so it stays free of the browser-only presentation
 * manifest.
 */
export const ENCOUNTER_RENDER_CONFIGS: ReadonlyMap<string, AuthoredEncounterRenderConfig> = new Map([
  ['yama_p3', YAMA_ENCOUNTER_RENDER_CONFIG],
  ['sol_heredit', SOL_HEREDIT_RENDER_CONFIG],
  ['inferno', INFERNO_RENDER_CONFIG],
]);

/**
 * Every NPC sequence the encounter render configs make the renderer play — the primary NPC's
 * death clip and each preloaded type's idle, walk override, spawn, death (default and per-cause)
 * and attack clips — with a label naming where it was declared. Cache-asset consumers (trimming,
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
      add(npc.walkSeqId, `${prefix} walk`);
      add(npc.spawnSeqId, `${prefix} spawn`);
      add(npc.deathSeqId, `${prefix} death`);
      for (const [cause, clip] of Object.entries(npc.deathClips ?? {})) add(clip.seqId, `${prefix} death:${cause}`);
      for (const [clipId, seqId] of Object.entries(npc.attackClips ?? {})) add(seqId, `${prefix} ${clipId}`);
    }
  }
  return ids;
}

/** An NPC type a scene loads, with the idle and walk overrides it loads with. */
export interface LoadedNpcType {
  readonly npcTypeId: number;
  readonly overrides: NpcBaseSeqOverrides | undefined;
  readonly label: string;
}

/**
 * Every NPC type a scene loads: each render config's primary NPC (with its preload entry, if any)
 * and preloaded types, and the lobby's bosses, which load with no overrides. Where a type has no
 * idle or walk override the scene plays its cache type's own (`npcBaseSeqIds`), so a consumer of
 * every playable clip resolves those against the cache: no render config names them.
 */
export function collectLoadedNpcTypes(
  configs: ReadonlyMap<string, AuthoredEncounterRenderConfig> = ENCOUNTER_RENDER_CONFIGS,
): LoadedNpcType[] {
  const loaded: LoadedNpcType[] = [];
  for (const [kind, config] of configs) {
    const preloads = config.preloadNpcTypes ?? [];
    const primary = config.primaryNpc;
    if (primary && !preloads.some((npc) => npc.npcTypeId === primary.npcTypeId)) {
      loaded.push({ npcTypeId: primary.npcTypeId, overrides: undefined, label: `${kind} npc ${primary.npcTypeId}` });
    }
    for (const npc of preloads) {
      loaded.push({ npcTypeId: npc.npcTypeId, overrides: npc, label: `${kind} npc ${npc.npcTypeId}` });
    }
  }
  for (const boss of LOBBY_BOSS_NPCS) {
    loaded.push({ npcTypeId: boss.npcTypeId, overrides: undefined, label: `lobby boss ${boss.npcTypeId}` });
  }
  return loaded;
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
