/**
 * Yama's encounter effects by family, declared once: his render config's `spotAnimIds` lists them
 * all for loading and readiness, and his scene and controllers draw from them. Plain ids, so the
 * render config stays importable in Node (`renderConfigs.ts`).
 */
import { SpotAnimID } from '../../rs/config/spotanimtype/SpotAnimID';

/** The shadow and fire wave walls, each stage. */
export const WAVE_PRELOAD_IDS = [
  SpotAnimID.VFX_SHADOW_WALL_SMALL,
  SpotAnimID.VFX_SHADOW_WALL_01,
  SpotAnimID.VFX_SHADOW_WALL_02,
  SpotAnimID.VFX_SHADOW_WALL_03,
  SpotAnimID.VFX_FIRE_WALL_01,
  SpotAnimID.VFX_FIRE_WALL_02,
  SpotAnimID.VFX_FIRE_WALL_03,
];

/** The falling rocks' impact and the flaming skull's. */
export const FIREBALL_PRELOAD_IDS = [
  SpotAnimID.VFX_PLAYER_YAMA_FALLING_ROCK_IMPACT01,
  SpotAnimID.VFX_FLAMING_SKULL_SHADOW_IMPACT01,
];

/** Always blue: which color a detonation shows is unresolved across the Yama captures. */
export const VOID_FLARE_EXPLOSION_SPOT_ANIM_ID = SpotAnimID.VFX_VOIDFLARE_EXPLODE_BLUE;

/** A void flare's detonation, and the human impact, a player graphic the encounter emits. */
export const VOID_FLARE_PRELOAD_IDS = [VOID_FLARE_EXPLOSION_SPOT_ANIM_ID, SpotAnimID.VFX_VOIDFLARE_HUMAN_IMPACT_BLUE];

/** Yama's casts and their impacts on the player. */
export const YAMA_ATTACK_PRELOAD_IDS = [
  SpotAnimID.VFX_NPC_YAMA_MAGIC_SHADOW_SPOTANIM01,
  SpotAnimID.VFX_NPC_YAMA_MAGIC_FIRE_SPOTANIM01,
  SpotAnimID.VFX_NPC_YAMA_FIRE_SKULL_SPOTANIM01,
  SpotAnimID.VFX_PLAYER_YAMA_MAGIC_SHADOW_IMPACT01,
  SpotAnimID.VFX_PLAYER_YAMA_MAGIC_FIRE_IMPACT01,
];
