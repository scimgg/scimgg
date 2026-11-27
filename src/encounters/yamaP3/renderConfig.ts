import { VOID_FLARE_DETONATED_DEATH_CAUSE } from '../../npcs/yama/timing';
import type { AuthoredEncounterRenderConfig } from '../../render/scene/encounterRenderConfig';
import { SpotAnimID } from '../../rs/config/spotanimtype/SpotAnimID';
import { YAMA_NPC_ID, YAMA_SIMULATOR_POSITION } from '../../rs/model/NpcModelLoader';
import { OSRS_TICK_MS } from '../../types/simulation';
import { YAMA_VICTORY_COMPLETION_DELAY_TICKS } from './constants';
import { YamaSceneObjectController } from './YamaSceneObjectController';

export const YAMA_ENCOUNTER_RENDER_CONFIG: AuthoredEncounterRenderConfig = {
  primaryNpc: {
    actorId: 'yama',
    npcTypeId: YAMA_NPC_ID,
    basePosition: [YAMA_SIMULATOR_POSITION.x, YAMA_SIMULATOR_POSITION.y],
    size: 5,
    deathSeqId: 12161,
    deathRetentionTicks: YAMA_VICTORY_COMPLETION_DELAY_TICKS,
    deathSpotAnimId: SpotAnimID.VFX_YAMA_COMBAT_DESPAWN_SPOTANIM01,
  },
  preloadNpcTypes: [
    {
      npcTypeId: 14179,
      idleSeqId: 12133,
      // npc_voidflare_death: a killed flare is `del`eted 3 ticks after it dies, which is this
      // clip's own 90-cycle length, so it needs no retention override.
      deathSeqId: 12134,
      deathClips: {
        // npc_voidflare_explode on the detonation tick, `del` exactly 2 ticks later
        // (capture yama-contract-forfeit-breath-p3-voidflare-explosions-packet-data.txt
        // :5220 Tick 2364 -> :5281 Tick 2366). The clip runs 30 cycles, holding its last frame after.
        [VOID_FLARE_DETONATED_DEATH_CAUSE]: { seqId: 12136, durationMs: 2 * OSRS_TICK_MS },
      },
      // npc_voidflare_spawn, sent on the voidflare's add tick
      // (capture yama-contract-of-bloodied-blows-voidflare-explosions-packet-data.txt:13862-13865).
      spawnSeqId: 12135,
    },
    {
      npcTypeId: YAMA_NPC_ID,
      // Per-beat attack animation clips (default / secondary-melee). Declared here
      // so the build-time cache trimmer warms their frame archives directly.
      attackClips: {
        default: 12144,
        secondary: 12146,
      },
    },
  ],
  // The start glyphs hint, a countdown-only practice aid.
  createSceneObjectController: () => new YamaSceneObjectController(),
};
