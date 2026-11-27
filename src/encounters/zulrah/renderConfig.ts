import {
  PLAYER_STUNNED_SPOTANIM_ID,
  SNAKELING_MAGIC_NPC_ID,
  SNAKELING_MAGIC_SPOTANIM_ID,
  SNAKELING_MELEE_NPC_ID,
  SNAKELING_SEQS,
  ZULRAH_CLOUD_ORB_SPOTANIM_ID,
  ZULRAH_MAGIC_NPC_ID,
  ZULRAH_MAGIC_SPOTANIM_ID,
  ZULRAH_MELEE_NPC_ID,
  ZULRAH_RANGED_NPC_ID,
  ZULRAH_RANGED_SPOTANIM_ID,
  ZULRAH_SEQS,
  ZULRAH_SNAKELING_ORB_SPOTANIM_ID,
} from '../../npcs/zulrah/constants';
import { FULL_MAP_SQUARE_ALL_LEVELS } from '../../render/environment/locRenderOptions';
import type { EncounterRenderConfig } from '../../render/scene/encounterRenderConfig';
import { ZULRAH_MAP_SQUARE, ZULRAH_MAP_SQUARE_OFFSETS } from './constants';
import { ZulrahSceneObjectController } from './ZulrahSceneObjectController';

const formType = (npcTypeId: number) => ({
  npcTypeId,
  idleSeqId: ZULRAH_SEQS.idle,
  // Every form change surfaces with EMERGEFAST; the fight's opening rise (`spawn`), `dive`, `attack`
  // and the tails are cued through `inferno_visual`.
  spawnSeqId: ZULRAH_SEQS.emerge,
  attackClips: {
    attack: ZULRAH_SEQS.attack,
    spawn: ZULRAH_SEQS.spawn,
    dive: ZULRAH_SEQS.dive,
    tailLeft: ZULRAH_SEQS.tailLeft,
    tailRight: ZULRAH_SEQS.tailRight,
  },
  deathSeqId: ZULRAH_SEQS.death,
});

const snakelingType = (npcTypeId: number) => ({
  npcTypeId,
  idleSeqId: SNAKELING_SEQS.idle,
  walkSeqId: SNAKELING_SEQS.walk,
  spawnSeqId: SNAKELING_SEQS.spawn,
  attackClips: { attack: SNAKELING_SEQS.attack },
  deathSeqId: SNAKELING_SEQS.death,
});

/**
 * Drawn by the Inferno compositor, whose `inferno_visual` cue handling is generic: every Zulrah form
 * is a preloaded type, and no primary NPC, since each form is its own short-lived actor.
 */
export const ZULRAH_RENDER_CONFIG: EncounterRenderConfig = {
  terrainMapSquare: ZULRAH_MAP_SQUARE,
  mapSquareOffsets: ZULRAH_MAP_SQUARE_OFFSETS,
  locRender: FULL_MAP_SQUARE_ALL_LEVELS,
  spotAnimIds: [
    ZULRAH_RANGED_SPOTANIM_ID,
    ZULRAH_MAGIC_SPOTANIM_ID,
    ZULRAH_CLOUD_ORB_SPOTANIM_ID,
    ZULRAH_SNAKELING_ORB_SPOTANIM_ID,
    SNAKELING_MAGIC_SPOTANIM_ID,
    PLAYER_STUNNED_SPOTANIM_ID,
  ],
  preloadNpcTypes: [
    formType(ZULRAH_RANGED_NPC_ID),
    formType(ZULRAH_MELEE_NPC_ID),
    formType(ZULRAH_MAGIC_NPC_ID),
    snakelingType(SNAKELING_MELEE_NPC_ID),
    snakelingType(SNAKELING_MAGIC_NPC_ID),
  ],
  // The venom clouds.
  createSceneObjectController: () => new ZulrahSceneObjectController(),
};
