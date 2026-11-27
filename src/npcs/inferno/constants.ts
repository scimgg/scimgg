// Recorded actor IDs: docs/encounters/zuk-facts-spec.md, section 1.
export const ZUK_NPC_ID = 7706;
export const ZUK_SHIELD_NPC_ID = 7707;
export const ZUK_MAGER_NPC_ID = 7703;
export const ZUK_RANGER_NPC_ID = 7702;
export const ZUK_JAD_NPC_ID = 7704;
export const ZUK_JAD_HEALER_NPC_ID = 7705;
export const ZUK_HEALER_NPC_ID = 7708;

export const ZUK_ACTOR_ID = 'zuk';

// The actor is 3x3, not the five-column safe band.
export const ZUK_SHIELD_SIZE = 3;

// docs/encounters/zuk-facts-spec.md, section 6: observed flight only, not a spark generator.
export const ZUK_SPARK_IMPACT_DELAY_TICKS = 3;

// Cache animation metadata plus recorded sequences; clip availability does not establish combat AI.
export const ZUK_SEQS = {
  zuk: { idle: 7564, spawn: 7563, attack: 7566, defend: 7565, death: 7562 },
  shield: { idle: 7567, hit: 7568, death: 7569 },
  ranger: { idle: 7602, walk: 7603, melee: 7604, range: 7605, defend: 7607, death: 7606 },
  mager: { idle: 7609, walk: 7608, magic: 7610, melee: 7612, death: 7613 },
  jad: { idle: 7589, walk: 7588, magic: 7592, range: 7593, melee: 7590, defend: 7591, death: 7594 },
  ytHurKot: { idle: 2636, walk: 2634, heal: 2639, attack: 2637, defend: 2635 },
  jalMejJak: { idle: 2867, walk: 2863, spawn: 2864, attack: 2868, defend: 2869, death: 2866 },
} as const;

// Ground NPC bases are coplanar with the Inferno floor; the reversed-Z nudge prevents z-fighting.
export const ZUK_GROUND_NPC_DEPTH_BIAS = 0.0005;

// Ordinary waves 1-68: docs/encounters/inferno-facts-spec.md (NPCs); names from RL NpcID.
export const INFERNO_WAVE_NPC_IDS = {
  nibbler: 7691,
  bat: 7692,
  blob: 7693,
  blob_mage: 7694,
  blob_range: 7695,
  blob_melee: 7696,
  meleer: 7697,
  ranger: 7698,
  mager: 7699,
  jad: 7700,
  jad_healer: 7701,
  pillar: 7709,
  pillarCollapse: 7710,
} as const;

/**
 * Attack, defend and death sequences from the facts spec (NPCs table); idle/walk from the cache
 * NpcType records. Keys are the `clipId`s these definitions emit in `encounter_visual`.
 * Ranger/mager/Jad/Yt-HurKot share `ZUK_SEQS`.
 */
export const INFERNO_WAVE_SEQS = {
  nibbler: { idle: 7573, walk: 7572, attack: 7574, defend: 7575, death: 7576 },
  bat: { idle: 7577, walk: 7577, attack: 7578, defend: 7579, death: 7580 },
  blob: { idle: 7586, walk: 7587, magic: 7581, melee: 7582, range: 7583, defend: 7585, death: 7584 },
  // The three children share the parent's model sequences and have no defend sequence.
  blobChild: { idle: 7586, walk: 7587, magic: 7581, melee: 7582, range: 7583, death: 7584 },
  meleer: { idle: 7595, walk: 7596, attack: 7597, defend: 7598, death: 7599, dig_down: 7600, dig_up: 7601 },
  mager: { resurrect: 7611 },
  pillarCollapse: 7561,
} as const;

/**
 * Every projectile and graphic the ordinary-wave definitions emit, shared ids included; the waves
 * render config preloads exactly these. Zuk's own list is `INFERNO_SPOT_ANIM_IDS`.
 */
export const INFERNO_WAVE_SPOT_ANIM_IDS = [
  1378, 1379, 1380, 1381, 1382, 1376, 1377, 131, 444, 448, 449, 450, 451,
] as const;

/** Every projectile and graphic wave 69 (TzKal-Zuk and his set) emits. */
export const INFERNO_SPOT_ANIM_IDS = [1375, 1376, 1377, 131, 448, 449, 450, 660, 659, 444, 451] as const;
