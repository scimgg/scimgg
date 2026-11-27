import { afterEach, describe, expect, it } from 'vitest';
import { setArenaConfig } from '../../../core/constants';
import { isYamaSnapshot } from '../../../core/encounters/snapshot';
import type { GameEvent } from '../../../core/events/types';
import type { ReplayDisplayFrame } from '../../../core/ReplayRecorder';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { YamaEncounter } from '../../../encounters/yamaP3/YamaEncounter';
import { SpotAnimID } from '../../../rs/config/spotanimtype/SpotAnimID';
import { ReplayEffectIndex } from '../../core/replayEffectIndex';
import { YamaReplayIndex } from '../yamaReplayIndex';

afterEach(() => {
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

function yamaFrames(): (tick: number, events?: GameEvent[], attack?: string) => ReplayDisplayFrame {
  const state = new SimulationEngine({ encounter: new YamaEncounter(), combatSeed: 1 }).getState();
  const snapshot = state.encounter;
  if (!isYamaSnapshot(snapshot)) throw new Error('Expected a Yama snapshot');
  return (tick, events = [], attack) => ({
    state: {
      ...state,
      currentTick: tick,
      encounter: attack
        ? { ...snapshot, state: { ...snapshot.state, lastAttackTick: tick, lastAttackKind: attack } }
        : snapshot,
    } as ReplayDisplayFrame['state'],
    events,
  });
}

const cast = (tick: number, attackKind: string): GameEvent => ({
  type: 'attack_started',
  eventId: tick,
  tick,
  sourceId: 'yama',
  targetId: 'player',
  attackKind,
});

describe("Yama's replay index, fed by the shared effect index's append pass", () => {
  it('reads every frame once, in order, as the history grows', () => {
    const frame = yamaFrames();
    const frames: ReplayDisplayFrame[] = [frame(10, [], 'magic_fire'), frame(11)];
    const yama = new YamaReplayIndex();
    const index = new ReplayEffectIndex(frames, yama);
    frames.push(frame(15, [], 'melee_crush'));
    index.extend();
    index.extend();

    expect(index.encounter).toBe(yama);
    // A reservation for the cast (its delay rides the trigger), the secondary clip at once for melee.
    expect(yama['primaries'].map(({ frameIndex, tick, value }) => [frameIndex, tick, value])).toEqual([
      [0, 10, { actorId: 'primary-npc', trigger: 'attack', tick: 10, durationGameTicks: 3, delayClientTicks: 30 }],
      [2, 15, { actorId: 'primary-npc', trigger: 'attack', tick: 15, clipId: 'secondary' }],
    ]);
  });

  it('replaces the latest cast and impact as each cast is emitted, never ahead of the cutoff', () => {
    const frame = yamaFrames();
    const yama = new YamaReplayIndex();
    new ReplayEffectIndex([frame(10, [cast(10, 'magic_fire')]), frame(14, [cast(14, 'magic_shadow')])], yama);

    expect(yama.latestAttack({ cycle: 299, throughFrameIndex: 1 })).toBeUndefined();
    expect(yama.latestAttack({ cycle: 14 * 30, throughFrameIndex: 0 })?.npcCast.spotAnimId).toBe(
      SpotAnimID.VFX_NPC_YAMA_MAGIC_FIRE_SPOTANIM01,
    );
    expect(yama.latestAttack({ cycle: 14 * 30, throughFrameIndex: 1 })).toEqual({
      npcCast: { spotAnimId: SpotAnimID.VFX_NPC_YAMA_MAGIC_SHADOW_SPOTANIM01, startCycle: 14 * 30 + 30 },
      playerImpact: { spotAnimId: SpotAnimID.VFX_PLAYER_YAMA_MAGIC_SHADOW_IMPACT01, startCycle: 14 * 30 },
    });
  });

  it('bounds flare history while retaining exact expiry and destruction events', () => {
    const frame = yamaFrames();
    const yama = new YamaReplayIndex();
    new ReplayEffectIndex(
      [
        frame(10, [
          { type: 'voidflare_exploded', eventId: 1, tick: 10, flareId: 'vf-1', position: [1, 1], variant: 'shadow' },
        ]),
        frame(12, [{ type: 'voidflare_destroyed', eventId: 2, tick: 12, flareId: 'vf-1' }]),
      ],
      yama,
    );

    const events = yama.recentFlareEvents({ cycle: 13 * 30, throughFrameIndex: 1 });

    expect(events.map((event) => event.type)).toEqual(['voidflare_exploded', 'voidflare_destroyed']);
  });
});
