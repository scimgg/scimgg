import { baseEncounterKind } from '../../encounters/catalog';
import { encounterRegistry } from '../../encounters/registry';
import { ENCOUNTER_RENDER_CONFIGS } from '../../encounters/renderConfigs';
import type { MapSquareOffsets } from '../../rs/map/mapSquareBlock';
import type { Coordinate, SimulationState } from '../../types/simulation';
import type { LocRenderOptions } from '../environment/locRenderOptions';
import type { SceneObjectLocData } from '../graphics/SceneObjectRenderer';
import type { SceneObjectController } from '../graphics/sceneObjectTypes';
import type { AnimPlayMode } from '../npc/animationTypes';
import { withDescriptorMapBlock } from './encounterMapBlock';

export interface NpcRenderConfig {
  actorId: string;
  npcTypeId: number;
  basePosition: Coordinate;
  size: number;
  deathSeqId: number;
  deathRetentionTicks?: number;
  deathSpotAnimId?: number;
}

export interface NpcDeathClipRenderConfig {
  seqId: number;
  durationMs?: number;
}

export interface EncounterNpcTypeRenderConfig {
  npcTypeId: number;
  idleSeqId?: number;
  /** Overrides the cache walk seq; -1 drops the walk clip so moving keeps the idle track running. */
  walkSeqId?: number;
  /** See {@link import('../npc/animationTypes').NpcAnimationSet.idlePlayMode}. */
  idlePlayMode?: AnimPlayMode;
  attackClips?: Record<string, number>;
  deathSeqId?: number;
  /**
   * One-shot clip every instance plays from its snapshot `spawnTick`, then returns to its
   * idle/base pose. Derived from the spawn tick rather than cued, so a replay seek lands on
   * the matching frame and an instance first seen after the clip has finished just idles.
   */
  spawnSeqId?: number;
  /**
   * Death clips selected by the dead snapshot's `deathCause`, in place of `deathSeqId`. Each
   * entry's `durationMs` is its corpse retention, as `deathDurationMs` is for the default clip;
   * omit it to retain the corpse for the clip's own length.
   */
  deathClips?: Record<string, NpcDeathClipRenderConfig>;
  /**
   * Corpse retention override in milliseconds. When set, the dying instance is
   * removed after this long instead of the death clip's full frame length.
   * For clips whose trailing frames are a held corpse pose rather than played
   * animation, set this to the true animation length.
   */
  deathDurationMs?: number;
  /**
   * The encounter removes this NPC from its snapshot when its corpse should go (e.g. Inferno's
   * per-species removal delays), so the corpse holds the death clip's last frame until then instead
   * of vanishing when the clip ends. The simulation stays the only source of removal timing; the
   * engine's dead-actor pruning bounds a corpse nothing removes. Overrides `deathDurationMs`.
   */
  holdDeathUntilRemoved?: boolean;
  /**
   * A dead `boss` stays in the snapshot, so it only plays its death clip when this opts in (as a
   * primary NPC always does). For a boss drawn as an ordinary instance, e.g. Inferno's TzKal-Zuk.
   */
  bossDeathAnimationEnabled?: boolean;
  depthBias?: number;
  /** Additional NDC depth offset for the translucent command, relative to whole-model depthBias. */
  transparentDepthBiasOffset?: number;
}

export type EncounterSceneObjectControllerFactory = () => SceneObjectController<SimulationState, SceneObjectLocData>;

export interface EncounterRenderConfig {
  primaryNpc?: NpcRenderConfig;
  preloadNpcTypes?: EncounterNpcTypeRenderConfig[];
  /**
   * Spot animations (projectiles and graphics) the encounter's events draw, preloaded with the
   * scene and required before a replay frame counts as presented. Read by the base compositor's
   * spot-anim hooks; compositors that override those hooks with their own list ignore it.
   */
  spotAnimIds?: readonly number[];
  /**
   * The origin map square (`map[x]_[y]` in the OSRS cache) the terrain mesh is built around.
   * Copied from the core descriptor by {@link getEncounterRenderConfig} so SceneCompositor stays
   * registry-agnostic; an authored config never declares it.
   */
  terrainMapSquare?: { x: number; y: number };
  /** Every square the scene draws (the descriptor footprint's scene block). Omitted: the origin alone. */
  mapSquareOffsets?: MapSquareOffsets;
  /**
   * The footprint's arena squares: the composed actor height grid, 3D tile-space overlays and the
   * hover/destination gates cover these. Omitted: the origin alone.
   */
  arenaMapSquareOffsets?: MapSquareOffsets;
  /**
   * Per-encounter loc-render filter, choosing how cache locs (walls, scenery,
   * pillars) around the playable area are clipped. Omit for self-contained
   * arena encounters where the playable area IS the scene (default: clip to
   * `getArenaBounds()` + 5 tiles, level 0 only). For arenas embedded in a
   * larger world scene, select
   * {@link import('../environment/locRenderOptions').FULL_MAP_SQUARE_GROUND_LEVEL}
   * or {@link import('../environment/locRenderOptions').FULL_MAP_SQUARE_ALL_LEVELS}
   * according to the cache planes that belong in the scene.
   */
  locRender?: LocRenderOptions;
  createSceneObjectController?: EncounterSceneObjectControllerFactory;
}

/** An encounter's authored render config (`ENCOUNTER_RENDER_CONFIGS`): the map footprint is the core descriptor's alone. */
export type AuthoredEncounterRenderConfig = Omit<
  EncounterRenderConfig,
  'terrainMapSquare' | 'mapSquareOffsets' | 'arenaMapSquareOffsets'
>;

/**
 * Render config per registered encounter kind: the authored config `ENCOUNTER_RENDER_CONFIGS` holds
 * for its base kind (a variant's parent), merged with `encounterKind`'s core descriptor map-square
 * block so `SceneCompositor` stays registry-agnostic. Undefined for a kind the registry does not run.
 *
 * Built lazily and memoized: `withDescriptorMapBlock` reads the encounter registry, populated
 * at the composition root's own module load (`src/encounters/registry.ts`), so no import order
 * can observe it empty.
 */
const RESOLVED_BY_KIND = new Map<string, EncounterRenderConfig | undefined>();

export function getEncounterRenderConfig(encounterKind: string): EncounterRenderConfig | undefined {
  if (RESOLVED_BY_KIND.has(encounterKind)) return RESOLVED_BY_KIND.get(encounterKind);
  const authored = encounterRegistry.hasKind(encounterKind)
    ? ENCOUNTER_RENDER_CONFIGS.get(baseEncounterKind(encounterKind))
    : undefined;
  const resolved = authored ? withDescriptorMapBlock(authored, encounterKind) : undefined;
  RESOLVED_BY_KIND.set(encounterKind, resolved);
  return resolved;
}
