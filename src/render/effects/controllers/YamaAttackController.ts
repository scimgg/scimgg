import type { GameEvent } from '../../../core/events/types';
import { SpotAnimID } from '../../../rs/config/spotanimtype/SpotAnimID';
import { getTerrainHeightInterpolated } from '../../shared/renderUtils';
import type { SpotAnimRenderer } from '../SpotAnimRenderer';
import { updateOneShotSpotAnim } from '../spotAnimPlayback';

const Z_ATTACK_YAMA = 46;
const Z_ATTACK_PLAYER = 71;
const CLIENT_TICKS_PER_GAME_TICK = 30;

// Non-melee attack timing (from packet data):
// Server sends everything on the beat tick with delay=30 on Yama's anim/spotanim.
// Player impact spotanim: no delay (starts immediately).
// Yama cast spotanim: delay=30 client ticks (1 game tick).
const YAMA_CAST_DELAY_CLIENT_TICKS = 30;

interface ActiveEffect {
  readonly spotAnimId: number;
  readonly startCycle: number;
}

export type YamaAttackDescriptor = {
  readonly npcCast: ActiveEffect;
  readonly playerImpact: ActiveEffect;
};

export function describeYamaAttack(event: GameEvent): YamaAttackDescriptor | undefined {
  if (event.type !== 'attack_started' || event.sourceId !== 'yama' || event.targetId !== 'player') return undefined;
  let cast: number;
  let impact: number;
  switch (event.attackKind) {
    case 'magic_fire':
      cast = SpotAnimID.VFX_NPC_YAMA_MAGIC_FIRE_SPOTANIM01;
      impact = SpotAnimID.VFX_PLAYER_YAMA_MAGIC_FIRE_IMPACT01;
      break;
    case 'magic_shadow':
    case 'range_shadow':
      cast = SpotAnimID.VFX_NPC_YAMA_MAGIC_SHADOW_SPOTANIM01;
      impact = SpotAnimID.VFX_PLAYER_YAMA_MAGIC_SHADOW_IMPACT01;
      break;
    default:
      return undefined;
  }
  const cycle = event.tick * CLIENT_TICKS_PER_GAME_TICK;
  return {
    npcCast: { spotAnimId: cast, startCycle: cycle + YAMA_CAST_DELAY_CLIENT_TICKS },
    playerImpact: { spotAnimId: impact, startCycle: cycle },
  };
}

export class YamaAttackController {
  private activeNpcCastEffect: ActiveEffect | null = null;
  private activePlayerImpactEffect: ActiveEffect | null = null;
  private terrainHeights: Int32Array[] | null = null;

  setTerrainHeights(heights: Int32Array[] | null): void {
    this.terrainHeights = heights;
  }

  consumeEvents(events: readonly GameEvent[]): void {
    for (const event of events) {
      const effect = describeYamaAttack(event);
      if (effect) this.consumeDescriptor(effect);
    }
  }

  consumeDescriptor(effect: {
    readonly npcCast: ActiveEffect | null;
    readonly playerImpact: ActiveEffect | null;
  }): void {
    this.activeNpcCastEffect = effect.npcCast;
    this.activePlayerImpactEffect = effect.playerImpact;
  }

  update(
    renderer: SpotAnimRenderer,
    _currentTick: number,
    interpolatedTick: number,
    playerVisualPosition: [number, number],
    npcCenter: readonly [number, number, number],
    npcFacingAngle: number,
    playerFacingAngle: number,
  ): void {
    const [npcCenterX, npcCenterY, npcHeight] = npcCenter;

    const playerWorldX = playerVisualPosition[0] + 0.5;
    const playerWorldY = playerVisualPosition[1] + 0.5;
    const playerWorldZ =
      -getTerrainHeightInterpolated(this.terrainHeights, playerVisualPosition[0], playerVisualPosition[1]) / 128;

    if (
      !this.renderEffect(
        renderer,
        this.activeNpcCastEffect,
        interpolatedTick,
        'attack-npc-cast',
        [npcCenterX, npcCenterY, npcHeight],
        Z_ATTACK_YAMA,
        npcFacingAngle,
      )
    ) {
      this.activeNpcCastEffect = null;
      renderer.despawn('attack-npc-cast');
    }

    if (
      !this.renderEffect(
        renderer,
        this.activePlayerImpactEffect,
        interpolatedTick,
        'attack-player-impact',
        [playerWorldX, playerWorldY, playerWorldZ],
        Z_ATTACK_PLAYER,
        playerFacingAngle,
      )
    ) {
      this.activePlayerImpactEffect = null;
      renderer.despawn('attack-player-impact');
    }
  }

  clearActive(renderer: SpotAnimRenderer): void {
    this.activeNpcCastEffect = null;
    this.activePlayerImpactEffect = null;
    renderer.despawn('attack-npc-cast');
    renderer.despawn('attack-player-impact');
  }

  private renderEffect(
    renderer: SpotAnimRenderer,
    effect: ActiveEffect | null,
    interpolatedTick: number,
    instanceId: string,
    position: [number, number, number],
    zIndex: number,
    yaw2048?: number,
  ): boolean {
    if (!effect) {
      return false;
    }

    const status = updateOneShotSpotAnim(
      renderer,
      {
        instanceId,
        spotAnimId: effect.spotAnimId,
        startCycle: effect.startCycle,
        transformSource: { kind: 'static', value: { position, yaw2048 } },
        style: { zIndex },
        heightOffsetMode: 'sequence',
        fallbackDurationCycles: 3 * CLIENT_TICKS_PER_GAME_TICK,
      },
      interpolatedTick * CLIENT_TICKS_PER_GAME_TICK,
    );
    switch (status) {
      case 'active':
      case 'pending':
      case 'unloaded':
        return true;
      case 'expired':
        return false;
      default: {
        const exhaustive: never = status;
        return exhaustive;
      }
    }
  }
}
