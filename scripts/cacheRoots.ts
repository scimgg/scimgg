/**
 * Every cache id the running app can request, enumerated from the runtime's own data registries
 * and unioned with the source scan (`discoverCacheUsage`) for ids that exist only as hard-coded
 * literals. This is the single root set both consumers start from:
 *
 *   - `trim-cache.ts` follows each root through the production loaders to decide what the
 *     trimmed production cache retains.
 *   - `check-trimmed-cache.ts` follows the same roots through raw archive reads to prove the
 *     built artifact still serves them.
 *
 * A root carries the label of the registry entry that declared it, so a missing archive can be
 * traced back to the data that needs it. `cacheRoots.test.ts` scans `src/` for id-bearing fields
 * and fails when one holds an id this walk does not reach, which is what keeps it from going
 * stale.
 */
import { ALL_SOUND_IDS } from '../src/audio/soundNames';
import { SPECIAL_ATTACK_REGISTRY } from '../src/core/combat/player/specialAttacks/registry';
import { getEquipmentCatalog } from '../src/data/equipmentCatalog';
import { getEquipmentCombatBaseId } from '../src/data/equipmentCombatFamilies';
import { ITEM_ACTIONS } from '../src/data/itemEffects';
import { collectItemIconIds } from '../src/data/itemIconIds';
import { SPELL_VISUALS } from '../src/data/spellVisuals';
import { PLAYER_ANIMATION_SEQ_IDS } from '../src/data/weaponAnimations';
import { getMeleeSweep, HANDWRITTEN_WEAPON_COMBAT_VISUALS } from '../src/data/weaponCombatVisuals';
import { WEAPON_ANIMATION_SETS, WEAPON_COMBAT_VISUALS } from '../src/data/weaponCombatVisuals.generated';
import { DUKE_GAZE_OVERLAY } from '../src/encounters/duke/constants';
import { LOBBY_BOSS_NPCS, LOBBY_PORTALS } from '../src/encounters/lobby/metadata';
import { ENCOUNTER_CORE_MODULES } from '../src/encounters/modules';
import {
  collectDeclaredNpcSeqIds,
  collectDeclaredSpotAnimIds,
  ENCOUNTER_RENDER_CONFIGS,
} from '../src/encounters/renderConfigs';
import { LOBBY_MAP_X, LOBBY_MAP_Y } from '../src/render/scene/lobby/lobbyConstants';
import { SpotAnimID } from '../src/rs/config/spotanimtype/SpotAnimID';
import { getTerrainContextLoadOffsets, type MapSquareOffsets } from '../src/rs/map/mapSquareBlock';
import { DEFAULT_MALE_APPEARANCE, type PlayerAppearance } from '../src/rs/model/PlayerModelLoader';
import { DEFAULT_PLAYER_CONFIG } from '../src/types/player';
import type { CacheUsage } from './discoverCacheUsage';

/** Cache indices the app reads models, config, sprites and maps from (`CacheManager` `LOADED_INDICES`). */
export const APP_INDICES = [0, 1, 2, 5, 7, 8, 9, 22] as const;

/**
 * Sound effects (index 4), which the runtime synth renders. Unlike the app indices, the trimmed
 * mirror keeps only the ids the app can play (`ALL_SOUND_IDS`), and the check fails if one is absent.
 */
export const SOUND_EFFECT_INDEX = 4;

/** Every index the trimmed mirror carries. */
export const MIRROR_INDICES = [...APP_INDICES, SOUND_EFFECT_INDEX] as const;

/** Archives of the config index (2) the app decodes at startup; must match `CacheManager`. */
export const APP_CONFIG_ARCHIVES = [1, 3, 4, 6, 8, 9, 10, 12, 13, 34] as const;

/** Each map holds root id -> label of the first declaration that reached it. */
export interface CacheRoots {
  readonly spotAnims: Map<number, string>;
  readonly seqs: Map<number, string>;
  readonly npcs: Map<number, string>;
  /** Models loaded directly by the renderer, outside an item, NPC, loc, or spotanim. */
  readonly models: Map<number, string>;
  /** Items the player can wear: their worn models, and those of their combat base item. */
  readonly wornItems: Map<number, string>;
  /** Items that can sit in a slot or on the ground: their inventory (ground) model. */
  readonly droppedItems: Map<number, string>;
  readonly identKits: Map<number, string>;
  /** Locs spawned at runtime rather than read from a map square's loc file. */
  readonly locs: Map<number, string>;
  readonly sprites: Map<number, string>;
  /** Sound effect archives in index 4, one per sound id. */
  readonly soundEffects: Map<number, string>;
  /** `"x,y"` of every map square the renderer loads, terrain-context ring included. */
  readonly mapSquares: Map<string, string>;
}

const SOURCE_LITERAL = 'src literal';

export function collectCacheRoots(usage?: CacheUsage): CacheRoots {
  const roots: CacheRoots = {
    spotAnims: new Map(),
    seqs: new Map(),
    npcs: new Map(),
    models: new Map(),
    wornItems: new Map(),
    droppedItems: new Map(),
    identKits: new Map(),
    locs: new Map(),
    sprites: new Map(),
    soundEffects: new Map(),
    mapSquares: new Map(),
  };
  const add = (into: Map<number, string>, id: number | undefined, label: string): void => {
    if (id !== undefined && Number.isInteger(id) && id >= 0 && !into.has(id)) into.set(id, label);
  };

  // Spotanims and the player's own animations.
  for (const [name, id] of Object.entries(SpotAnimID)) add(roots.spotAnims, id, `SpotAnimID.${name}`);
  for (const [item, def] of Object.entries(ITEM_ACTIONS)) {
    add(roots.spotAnims, def.playerGraphic, `ITEM_ACTIONS[${item}].playerGraphic`);
  }
  for (const [item, def] of Object.entries(SPECIAL_ATTACK_REGISTRY)) {
    const at = `SPECIAL_ATTACK_REGISTRY[${item}]`;
    add(roots.seqs, def.animationId, `${at}.animationId`);
    add(roots.spotAnims, def.graphicId, `${at}.graphicId`);
    add(roots.spotAnims, def.targetGraphic?.spotAnimId, `${at}.targetGraphic`);
    for (const id of def.onKillEffect?.targetGraphicBySize ?? []) {
      add(roots.spotAnims, id, `${at}.onKillEffect.targetGraphicBySize`);
    }
  }
  for (const [spell, v] of Object.entries(SPELL_VISUALS)) {
    const at = `SPELL_VISUALS[${spell}]`;
    add(roots.seqs, v.castAnimationId, `${at}.castAnimationId`);
    add(roots.seqs, v.fallbackAnimationId, `${at}.fallbackAnimationId`);
    add(roots.spotAnims, v.castSpotanimId, `${at}.castSpotanimId`);
    add(roots.spotAnims, v.hitSpotanimId, `${at}.hitSpotanimId`);
    add(roots.spotAnims, v.projectileId, `${at}.projectileId`);
  }
  const weaponVisuals = [
    ...Object.entries(WEAPON_COMBAT_VISUALS).map(([item, v]) => [`WEAPON_COMBAT_VISUALS[${item}]`, v] as const),
    ...HANDWRITTEN_WEAPON_COMBAT_VISUALS.map((v, i) => [`HANDWRITTEN_WEAPON_COMBAT_VISUALS[${i}]`, v] as const),
  ];
  for (const [at, v] of weaponVisuals) {
    add(roots.seqs, v.attackAnimation, `${at}.attackAnimation`);
    add(roots.spotAnims, v.castSpotanim, `${at}.castSpotanim`);
    add(roots.spotAnims, v.projectileId, `${at}.projectileId`);
    add(roots.spotAnims, v.hitSpotanim, `${at}.hitSpotanim`);
  }
  for (const [weapon, set] of Object.entries(WEAPON_ANIMATION_SETS)) {
    for (const [slot, id] of Object.entries(set)) {
      if (typeof id === 'number') add(roots.seqs, id, `WEAPON_ANIMATION_SETS[${weapon}].${slot}`);
    }
  }
  for (const id of PLAYER_ANIMATION_SEQ_IDS) add(roots.seqs, id, 'PLAYER_ANIMATION_SEQ_IDS');
  add(roots.models, DUKE_GAZE_OVERLAY.modelId, 'Duke Freezing Gaze overlay');
  for (const id of DUKE_GAZE_OVERLAY.sequenceIds) add(roots.seqs, id, 'Duke Freezing Gaze overlay');

  // Equipment and items.
  const catalog = getEquipmentCatalog();
  for (const item of catalog) {
    add(roots.wornItems, item.id, `equipment catalog ${item.id}`);
    add(roots.wornItems, getEquipmentCombatBaseId(item.id), `combat base of equipment catalog ${item.id}`);
    for (const direction of ['south', 'north', 'east', 'west'] as const) {
      add(roots.spotAnims, getMeleeSweep(item.id, direction)?.spotAnimId, `getMeleeSweep(${item.id}, ${direction})`);
    }
  }
  for (const id of collectItemIconIds()) add(roots.droppedItems, id, `collectItemIconIds ${id}`);
  const appearances: [string, PlayerAppearance][] = [
    ['DEFAULT_PLAYER_CONFIG.appearance', DEFAULT_PLAYER_CONFIG.appearance],
    ['DEFAULT_MALE_APPEARANCE', DEFAULT_MALE_APPEARANCE],
  ];
  for (const [at, appearance] of appearances) {
    for (const key of ['hairKit', 'jawKit', 'torsoKit', 'armsKit', 'handsKit', 'legsKit', 'feetKit'] as const) {
      add(roots.identKits, appearance[key], `${at}.${key}`);
    }
  }

  for (const id of ALL_SOUND_IDS) add(roots.soundEffects, id, 'ALL_SOUND_IDS');

  // Encounters and the lobby.
  for (const [kind, config] of ENCOUNTER_RENDER_CONFIGS) {
    const primary = config.primaryNpc;
    if (primary) add(roots.npcs, primary.npcTypeId, `${kind} render config primaryNpc`);
    for (const npc of config.preloadNpcTypes ?? []) {
      add(roots.npcs, npc.npcTypeId, `${kind} render config preloadNpcTypes`);
    }
  }
  for (const [seqId, label] of collectDeclaredNpcSeqIds()) add(roots.seqs, seqId, label);
  for (const [spotAnimId, label] of collectDeclaredSpotAnimIds()) add(roots.spotAnims, spotAnimId, label);
  for (const module of ENCOUNTER_CORE_MODULES) {
    const { mapSquare, mapSquareOffsets } = module.descriptor;
    addMapSquares(roots, mapSquare, mapSquareOffsets, `${module.kind} descriptor mapSquare`);
  }
  for (const boss of LOBBY_BOSS_NPCS) add(roots.npcs, boss.npcTypeId, `LOBBY_BOSS_NPCS ${boss.actorId}`);
  for (const portal of LOBBY_PORTALS) add(roots.locs, portal.locId, `LOBBY_PORTALS ${portal.encounterKind}`);
  addMapSquares(roots, { x: LOBBY_MAP_X, y: LOBBY_MAP_Y }, undefined, 'LOBBY_MAP_X/Y');

  // Ids that exist only as hard-coded literals in src/.
  if (usage) {
    for (const id of usage.npcIds) add(roots.npcs, id, SOURCE_LITERAL);
    for (const id of usage.spotAnimIds) add(roots.spotAnims, id, SOURCE_LITERAL);
    for (const id of usage.spriteIds) add(roots.sprites, id, SOURCE_LITERAL);
    for (const id of usage.seqIds) add(roots.seqs, id, SOURCE_LITERAL);
    for (const id of usage.itemIds) add(roots.droppedItems, id, SOURCE_LITERAL);
    for (const id of usage.locIds) add(roots.locs, id, SOURCE_LITERAL);
    for (const key of usage.mapSquares) {
      const [x, y] = key.split(',').map(Number);
      addMapSquares(roots, { x, y }, undefined, SOURCE_LITERAL);
    }
  }
  return roots;
}

/** Adds the rendered squares plus the +/-1 ring `getTerrainContextLoadOffsets` makes the renderer read. */
function addMapSquares(
  roots: CacheRoots,
  base: { readonly x: number; readonly y: number },
  offsets: MapSquareOffsets | undefined,
  label: string,
): void {
  for (const { dx, dy } of getTerrainContextLoadOffsets(offsets ?? [{ dx: 0, dy: 0 }])) {
    const key = `${base.x + dx},${base.y + dy}`;
    if (!roots.mapSquares.has(key)) roots.mapSquares.set(key, label);
  }
}

/**
 * Deterministic text of the registry-walked root ids (labels excluded), for the trace-spec
 * fingerprint: any change to what the registries can request forces a re-trim.
 */
export function serializeRegistryRoots(): string {
  const roots = collectCacheRoots();
  return Object.entries(roots)
    .map(([kind, ids]: [string, Map<number | string, string>]) => {
      const keys = [...ids.keys()].map(String).sort();
      return `${kind}=${keys.join(',')}`;
    })
    .join('\n');
}
