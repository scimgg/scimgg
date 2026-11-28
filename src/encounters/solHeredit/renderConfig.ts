import {
  BEAM_CRYSTAL_NPC_ID,
  BEES_NPC_ID,
  COLOSSEUM_SEQS,
  HEALING_TOTEM_NPC_ID,
  SOL_ACTOR_ID,
  SOL_NPC_ID,
  SOL_SIZE,
  SOLARFLARE_NPC_ID,
  WARBAND_ARCHER_NPC_ID,
  WARBAND_BERSERKER_NPC_ID,
  WARBAND_SEER_NPC_ID,
} from '../../npcs/colosseum/constants';
import { JAGUAR_WARRIOR_NPC_ID, JAGUAR_WARRIOR_SEQS } from '../../npcs/colosseum/jaguarWarrior';
import { JAVELIN_COLOSSUS_NPC_ID, JAVELIN_COLOSSUS_SEQS } from '../../npcs/colosseum/javelinColossus';
import { MANTICORE_NPC_ID, MANTICORE_SEQS } from '../../npcs/colosseum/manticore';
import { MINOTAUR_NPC_ID, MINOTAUR_ROUTEFIND_NPC_ID, MINOTAUR_SEQS } from '../../npcs/colosseum/minotaur';
import { SERPENT_SHAMAN_NPC_ID, SERPENT_SHAMAN_SEQS } from '../../npcs/colosseum/serpentShaman';
import { SHOCKWAVE_COLOSSUS_NPC_ID, SHOCKWAVE_COLOSSUS_SEQS } from '../../npcs/colosseum/shockwaveColossus';
import { COLOSSEUM_SPOT_ANIM_IDS } from '../../npcs/colosseum/visualEvents';
import { FLOOR_EFFECT_DEPTH_BIAS } from '../../render/effects/spotAnimRenderPolicy';
import { FULL_MAP_SQUARE_ALL_LEVELS } from '../../render/environment/locRenderOptions';
import type {
  AuthoredEncounterRenderConfig,
  EncounterNpcTypeRenderConfig,
} from '../../render/scene/encounterRenderConfig';
import type { Coordinate } from '../../types/simulation';
import { type VolatilityGib, volatilityGibForNpcType } from '../colosseum/modifiers/volatility';
import { SOL_START_POSITION } from './constants';
import { SolHereditSceneObjectController } from './SolHereditSceneObjectController';

// Empirical tolerance for the totem's coplanar platform glow: eight D24 window-depth
// steps in NDC, toward the camera under reversed-Z. Not a cache-derived face bias.
const TOTEM_TRANSPARENT_DEPTH_BIAS_OFFSET = (8 * 2) / (2 ** 24 - 1);

/**
 * Waves 1-11's species. Each idle and walk is its cache NpcType's own (cache 2772), declared so
 * their frame sounds are extracted with the other clips. The wave owner removes a corpse at its
 * death sequence +3 (jaguar, shaman, javelin) or +4 (minotaur, manticore, shockwave), so each holds
 * its death clip's last frame until its snapshot entry goes. Spawn clips play from the add tick.
 */
const WAVE_SPECIES: readonly EncounterNpcTypeRenderConfig[] = [
  {
    npcTypeId: JAGUAR_WARRIOR_NPC_ID,
    idleSeqId: 808,
    walkSeqId: 819,
    spawnSeqId: JAGUAR_WARRIOR_SEQS.spawn,
    attackClips: { attack: JAGUAR_WARRIOR_SEQS.attack },
    deathSeqId: JAGUAR_WARRIOR_SEQS.death,
    holdDeathUntilRemoved: true,
  },
  {
    npcTypeId: SERPENT_SHAMAN_NPC_ID,
    idleSeqId: 813,
    walkSeqId: 1205,
    spawnSeqId: SERPENT_SHAMAN_SEQS.spawn,
    attackClips: { attack: SERPENT_SHAMAN_SEQS.cast },
    deathSeqId: SERPENT_SHAMAN_SEQS.death,
    holdDeathUntilRemoved: true,
  },
  // 12813 is Red Flag's routing minotaur: the same model and clips.
  ...[MINOTAUR_NPC_ID, MINOTAUR_ROUTEFIND_NPC_ID].map((npcTypeId) => ({
    npcTypeId,
    idleSeqId: 10840,
    walkSeqId: 10842,
    spawnSeqId: MINOTAUR_SEQS.spawn,
    attackClips: { attack: MINOTAUR_SEQS.attack, heal: MINOTAUR_SEQS.heal, defend: MINOTAUR_SEQS.defend },
    deathSeqId: MINOTAUR_SEQS.death,
    holdDeathUntilRemoved: true,
  })),
  {
    npcTypeId: MANTICORE_NPC_ID,
    idleSeqId: MANTICORE_SEQS.idle,
    walkSeqId: MANTICORE_SEQS.walk,
    spawnSeqId: MANTICORE_SEQS.spawn,
    attackClips: { charge: MANTICORE_SEQS.charge, throw: MANTICORE_SEQS.throw },
    deathSeqId: MANTICORE_SEQS.death,
    holdDeathUntilRemoved: true,
  },
  {
    npcTypeId: JAVELIN_COLOSSUS_NPC_ID,
    idleSeqId: JAVELIN_COLOSSUS_SEQS.idle,
    walkSeqId: JAVELIN_COLOSSUS_SEQS.walk,
    attackClips: { attack: JAVELIN_COLOSSUS_SEQS.attack, artillery: JAVELIN_COLOSSUS_SEQS.artillery },
    deathSeqId: JAVELIN_COLOSSUS_SEQS.death,
    holdDeathUntilRemoved: true,
  },
  {
    npcTypeId: SHOCKWAVE_COLOSSUS_NPC_ID,
    idleSeqId: SHOCKWAVE_COLOSSUS_SEQS.idle,
    walkSeqId: SHOCKWAVE_COLOSSUS_SEQS.walk,
    attackClips: { attack: SHOCKWAVE_COLOSSUS_SEQS.attack },
    deathSeqId: SHOCKWAVE_COLOSSUS_SEQS.death,
    holdDeathUntilRemoved: true,
  },
];

/**
 * The gibs a Volatility death leaves (12828-12831), one per gib type the species map to. Their cache
 * NpcTypes have no stand, so each plays its gib sequence once from its add tick and holds the last
 * frame until it is removed three ticks later.
 */
const VOLATILITY_GIBS: readonly EncounterNpcTypeRenderConfig[] = [
  ...new Map(
    WAVE_SPECIES.flatMap(({ npcTypeId }): [number, VolatilityGib][] => {
      const gib = volatilityGibForNpcType(npcTypeId);
      return gib ? [[gib.npcTypeId, gib]] : [];
    }),
  ).values(),
].map((gib) => ({ npcTypeId: gib.npcTypeId, spawnSeqId: gib.sequenceId }));

export const SOL_HEREDIT_RENDER_CONFIG: AuthoredEncounterRenderConfig = {
  primaryNpc: {
    actorId: SOL_ACTOR_ID,
    npcTypeId: SOL_NPC_ID,
    basePosition: [...SOL_START_POSITION] satisfies Coordinate,
    size: SOL_SIZE,
    deathSeqId: COLOSSEUM_SEQS.sol.death,
  },
  preloadNpcTypes: [
    {
      npcTypeId: SOLARFLARE_NPC_ID,
      idleSeqId: COLOSSEUM_SEQS.solarflare.idle,
      // The stand seq opens with a one-time flare-up (and its sound), then loops only its tail.
      // The cache walk seq is the same seq, so a separate walk clip would restart the flare-up
      // on every crawl step; and looping the whole seq would replay it every cycle.
      walkSeqId: -1,
      idlePlayMode: 'loopFrameStep',
    },
    {
      npcTypeId: BEES_NPC_ID,
      idleSeqId: COLOSSEUM_SEQS.bees.idle,
      attackClips: { spawn: COLOSSEUM_SEQS.bees.spawn, attack: COLOSSEUM_SEQS.bees.attack },
      deathSeqId: COLOSSEUM_SEQS.bees.despawn,
    },
    {
      npcTypeId: HEALING_TOTEM_NPC_ID,
      transparentDepthBiasOffset: TOTEM_TRANSPARENT_DEPTH_BIAS_OFFSET,
      idleSeqId: COLOSSEUM_SEQS.totem.idle,
      // Cache seq 10827 (rev 232): 51 frames, frameStep 36, so frames 0-14 play once and only
      // frames 15-50 loop after them.
      idlePlayMode: 'loopFrameStep',
      attackClips: { attack: COLOSSEUM_SEQS.totem.attack },
      // No death seq exists; Run A removes a killed totem three ticks after the killing hit (37/43).
      deathDurationMs: 1800,
    },
    // The Quartet warbander; its walk comes from the cache NpcType.
    ...(
      [
        [WARBAND_BERSERKER_NPC_ID, COLOSSEUM_SEQS.warband.berserker],
        [WARBAND_ARCHER_NPC_ID, COLOSSEUM_SEQS.warband.archer],
        [WARBAND_SEER_NPC_ID, COLOSSEUM_SEQS.warband.seer],
      ] as const
    ).map(([npcTypeId, seqs]) => ({
      npcTypeId,
      idleSeqId: seqs.idle,
      attackClips: { attack: seqs.attack, defend: seqs.defend },
      spawnSeqId: COLOSSEUM_SEQS.warband.spawn,
      deathSeqId: seqs.death,
      // The death clip plays 47 cycles then holds its last frame for 20000; the capture removes the
      // corpse three ticks after the death sequence starts (89/89).
      deathDurationMs: 1800,
    })),
    {
      npcTypeId: SOL_NPC_ID,
      idleSeqId: COLOSSEUM_SEQS.sol.idle,
      // Sol's attacks ARE their telegraphs: the warning animation plays three ticks before the
      // ground effects land, which is the whole readable part of the fight.
      attackClips: {
        attack: COLOSSEUM_SEQS.sol.spearTelegraph,
        spear: COLOSSEUM_SEQS.sol.spearTelegraph,
        shield: COLOSSEUM_SEQS.sol.shieldTelegraph,
        grapple: COLOSSEUM_SEQS.sol.grappleTelegraph,
        triple: COLOSSEUM_SEQS.sol.tripleLong,
        tripleShort: COLOSSEUM_SEQS.sol.tripleShort,
      },
      deathSeqId: COLOSSEUM_SEQS.sol.death,
      // His shield slam drives the shield into the floor, as Zuk's ground NPCs meet theirs.
      depthBias: FLOOR_EFFECT_DEPTH_BIAS,
    },
    {
      npcTypeId: BEAM_CRYSTAL_NPC_ID,
      idleSeqId: COLOSSEUM_SEQS.crystal.idle,
      attackClips: {
        charge: COLOSSEUM_SEQS.crystal.charge,
        attack: COLOSSEUM_SEQS.crystal.attack,
        spawn: COLOSSEUM_SEQS.crystal.spawn,
        // Played on Sol's death tick; the crystal is removed, not killed, a tick later.
        despawn: COLOSSEUM_SEQS.crystal.despawn,
      },
      deathSeqId: COLOSSEUM_SEQS.crystal.despawn,
    },
    ...WAVE_SPECIES,
    ...VOLATILITY_GIBS,
  ],
  spotAnimIds: COLOSSEUM_SPOT_ANIM_IDS,
  // The arena sits inside a much larger amphitheater, so the whole map square renders. Its seating
  // ring is map level 1 and its awnings level 2 (level 3 is empty). Every tile with level 1 or 2
  // content is a bridge (level 1 flag 0x2, drawn as the player's plane) or visible-below (0x8),
  // so the client draws them from the arena floor; ColosseumAssets.test.ts checks this in the cache.
  locRender: FULL_MAP_SQUARE_ALL_LEVELS,
  // Molten sand pools are real LOCs in both captures and persist until Sol dies, so they are
  // scene objects driven by the snapshot rather than one-shot effects.
  createSceneObjectController: () => new SolHereditSceneObjectController(),
};
