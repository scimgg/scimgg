import { DUKE_ASLEEP_NPC_ID, DUKE_NPC_ID, WARDEN_ID, WARDEN_SIZE } from '../../npcs/duke/duke';
import type { SceneObjectLocData } from '../../render/graphics/SceneObjectRenderer';
import type { SceneObjectSpec } from '../../render/graphics/sceneObjectTypes';
import type { EncounterRenderConfig } from '../../render/scene/encounterRenderConfig';
import { LocModelType } from '../../rs/config/loctype/LocModelType';
import { WARDEN_TILE } from './arena';
import { DUKE_BILE_POOL_LOC_ID, DUKE_MAP_SQUARE, DUKE_ORB_NPC_ID, DUKE_SEQS, DUKE_SPOT_ANIMS } from './constants';
import { DUKE_PRACTICE_KIND } from './controls';

const POOL_LOCAL_TRANSFORM = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export const DUKE_PRACTICE_RENDER_CONFIG: EncounterRenderConfig = {
  terrainMapSquare: DUKE_MAP_SQUARE,
  locRender: { bounds: { minX: 19, maxX: 43, minY: 33, maxY: 62 }, marginTiles: 0, levels: [0, 1] },
  primaryNpc: {
    actorId: WARDEN_ID,
    npcTypeId: DUKE_NPC_ID,
    basePosition: [...WARDEN_TILE],
    size: WARDEN_SIZE,
    deathSeqId: DUKE_SEQS.death,
  },
  preloadNpcTypes: [
    {
      npcTypeId: DUKE_ASLEEP_NPC_ID,
      idleSeqId: DUKE_SEQS.asleep,
      attackClips: { wake: DUKE_SEQS.wake },
      deathSeqId: DUKE_SEQS.death,
      bossDeathAnimationEnabled: true,
    },
    {
      npcTypeId: DUKE_NPC_ID,
      idleSeqId: DUKE_SEQS.awake,
      attackClips: {
        wake: DUKE_SEQS.wake,
        slam: DUKE_SEQS.slam,
        magic: DUKE_SEQS.magic,
        fastMagic: DUKE_SEQS.fastMagic,
        gaze: DUKE_SEQS.gaze,
        bile: DUKE_SEQS.fastMagic,
      },
    },
    { npcTypeId: DUKE_ORB_NPC_ID },
  ],
  spotAnimIds: Object.values(DUKE_SPOT_ANIMS),
  createSceneObjectController: () => ({
    consumeEvents() {},
    update({ state }) {
      if (state.encounter.kind !== DUKE_PRACTICE_KIND) return [];

      const pools: SceneObjectSpec<SceneObjectLocData>[] = [];
      for (const hazard of state.encounter.visuals.hazards) {
        if (hazard.kind !== 'bile') continue;
        for (const [x, y] of hazard.tiles) {
          const id = `duke-bile-pool-${x}-${y}`;
          pools.push({
            id,
            meshId: id,
            materialId: 'osrs-npc',
            modelMatrix: POOL_LOCAL_TRANSFORM,
            lifecycle: { kind: 'sync' },
            classification: 'groundDecal',
            data: {
              kind: 'loc',
              locId: DUKE_BILE_POOL_LOC_ID,
              // Captured pool placements use LOC type 10 (20261126-232238-Duke.jsonl:6586).
              modelType: LocModelType.NORMAL,
              rotation: 0,
              seqId: -1,
              localX: x,
              localY: y,
            },
          });
        }
      }
      return pools;
    },
  }),
};
