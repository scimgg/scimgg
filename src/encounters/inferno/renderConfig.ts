import {
  INFERNO_SPOT_ANIM_IDS,
  INFERNO_WAVE_NPC_IDS,
  INFERNO_WAVE_SEQS,
  INFERNO_WAVE_SPOT_ANIM_IDS,
  ZUK_GROUND_NPC_DEPTH_BIAS,
  ZUK_SEQS,
} from '../../npcs/inferno/constants';
import { FULL_MAP_SQUARE_GROUND_LEVEL, type LocExclusionRegion } from '../../render/environment/locRenderOptions';
import type { AuthoredEncounterRenderConfig } from '../../render/scene/encounterRenderConfig';
import { ZUK_ALCOVE_STATIC_LOCS } from '../zuk/alcoveScenery';
import { ZUK_WAVE_NPC_TYPES } from '../zuk/renderConfig';
import { INFERNO_PILLAR_COLLAPSE_NPC_ID, INFERNO_PILLAR_NPC_ID } from './constants';
import { InfernoSceneObjectController } from './sceneObjects';

/**
 * Inclusive region-local rectangle covering the playable arena floor. Every LOC in this window is
 * stripped before the scene is baked. Alcove scenery at y>=46 (rock outcrops, prison walls, glyph)
 * sits outside it; the walls and the static glyph are the scene controller's (`zukAlcoveLocs`).
 */
const ARENA_CLUTTER_EXCLUSION: LocExclusionRegion = { minX: 17, maxX: 45, minY: 17, maxY: 45 };
// RuneLite cache gameval LIZARD_CLERIC_DEATH, as in the Zuk render config.
const YT_HURKOT_DEATH_SEQ = 2638;

const ids = INFERNO_WAVE_NPC_IDS;
const seqs = INFERNO_WAVE_SEQS;
const ground = ZUK_GROUND_NPC_DEPTH_BIAS;
const child = seqs.blobChild;
// Corpses stay until the encounter removes them (`INFERNO_REMOVAL_DELAY_TICKS`, Jad's +6), which is
// longer than most death clips. Yt-HurKot is removed with its Jad, so it keeps its clip length.
const holdDeathUntilRemoved = true;

/**
 * The Inferno's one render config, waves 1-69. Clip ids are the names the definitions cue through
 * `encounter_visual` animations. Seqs: the facts spec NPC table and cache NpcType defaults
 * (`INFERNO_WAVE_SEQS`); the four species shared with wave 69 use `ZUK_SEQS`; wave 69's own types
 * are `ZUK_WAVE_NPC_TYPES`. No primary NPC: Zuk is drawn from the snapshot, so he is not in the
 * alcove before wave 69 adds him.
 */
export const INFERNO_RENDER_CONFIG: AuthoredEncounterRenderConfig = {
  spotAnimIds: [...new Set<number>([...INFERNO_WAVE_SPOT_ANIM_IDS, ...INFERNO_SPOT_ANIM_IDS])],
  preloadNpcTypes: [
    {
      npcTypeId: ids.nibbler,
      idleSeqId: seqs.nibbler.idle,
      attackClips: { attack: seqs.nibbler.attack, defend: seqs.nibbler.defend },
      deathSeqId: seqs.nibbler.death,
      holdDeathUntilRemoved,
      depthBias: ground,
    },
    {
      npcTypeId: ids.bat,
      idleSeqId: seqs.bat.idle,
      attackClips: { attack: seqs.bat.attack, defend: seqs.bat.defend },
      deathSeqId: seqs.bat.death,
      holdDeathUntilRemoved,
    },
    {
      npcTypeId: ids.blob,
      idleSeqId: seqs.blob.idle,
      attackClips: { magic: seqs.blob.magic, melee: seqs.blob.melee, range: seqs.blob.range, defend: seqs.blob.defend },
      deathSeqId: seqs.blob.death,
      holdDeathUntilRemoved,
      depthBias: ground,
    },
    ...[ids.blob_mage, ids.blob_range, ids.blob_melee].map((npcTypeId) => ({
      npcTypeId,
      idleSeqId: child.idle,
      attackClips: { magic: child.magic, melee: child.melee, range: child.range },
      deathSeqId: child.death,
      holdDeathUntilRemoved,
      depthBias: ground,
    })),
    {
      npcTypeId: ids.meleer,
      idleSeqId: seqs.meleer.idle,
      attackClips: {
        attack: seqs.meleer.attack,
        defend: seqs.meleer.defend,
        dig_down: seqs.meleer.dig_down,
        dig_up: seqs.meleer.dig_up,
      },
      deathSeqId: seqs.meleer.death,
      holdDeathUntilRemoved,
      depthBias: ground,
    },
    {
      npcTypeId: ids.ranger,
      idleSeqId: ZUK_SEQS.ranger.idle,
      attackClips: { range: ZUK_SEQS.ranger.range, melee: ZUK_SEQS.ranger.melee, defend: ZUK_SEQS.ranger.defend },
      deathSeqId: ZUK_SEQS.ranger.death,
      holdDeathUntilRemoved,
      depthBias: ground,
    },
    {
      npcTypeId: ids.mager,
      idleSeqId: ZUK_SEQS.mager.idle,
      attackClips: { magic: ZUK_SEQS.mager.magic, melee: ZUK_SEQS.mager.melee, resurrect: seqs.mager.resurrect },
      deathSeqId: ZUK_SEQS.mager.death,
      holdDeathUntilRemoved,
      depthBias: ground,
    },
    {
      npcTypeId: ids.jad,
      idleSeqId: ZUK_SEQS.jad.idle,
      attackClips: {
        magic: ZUK_SEQS.jad.magic,
        range: ZUK_SEQS.jad.range,
        melee: ZUK_SEQS.jad.melee,
        defend: ZUK_SEQS.jad.defend,
      },
      deathSeqId: ZUK_SEQS.jad.death,
      holdDeathUntilRemoved,
      depthBias: ground,
    },
    {
      npcTypeId: ids.jad_healer,
      idleSeqId: ZUK_SEQS.ytHurKot.idle,
      attackClips: { heal: ZUK_SEQS.ytHurKot.heal, melee: ZUK_SEQS.ytHurKot.attack, defend: ZUK_SEQS.ytHurKot.defend },
      deathSeqId: YT_HURKOT_DEATH_SEQ,
      // The death seq's last frame holds for 20000 cycles; keep the true 90-cycle animation (as on Zuk).
      deathDurationMs: 1800,
      depthBias: ground,
    },
    // `inferno_invisible_3x3`: its cache model is scaled to width 1, so it draws nothing visible.
    { npcTypeId: INFERNO_PILLAR_NPC_ID },
    {
      npcTypeId: INFERNO_PILLAR_COLLAPSE_NPC_ID,
      spawnSeqId: seqs.pillarCollapse,
      depthBias: ground,
    },
    ...ZUK_WAVE_NPC_TYPES,
  ],
  // The full Inferno map square (region 9043), arena floor clutter stripped. The alcove's prison
  // walls and static glyph change on wave 69, so the scene controller draws them in every state.
  locRender: {
    ...FULL_MAP_SQUARE_GROUND_LEVEL,
    excludedRegions: [ARENA_CLUTTER_EXCLUSION],
    excludedLocs: ZUK_ALCOVE_STATIC_LOCS,
  },
  createSceneObjectController: () => new InfernoSceneObjectController(),
};
