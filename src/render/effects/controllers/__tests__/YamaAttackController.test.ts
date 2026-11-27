import { describe, expect, it } from 'vitest';
import type { AttackKind, GameEvent } from '../../../../core/events/types';
import { YAMA_ATTACK_PRELOAD_IDS } from '../../../../encounters/yamaP3/spotAnims';
import { SpotAnimID } from '../../../../rs/config/spotanimtype/SpotAnimID';
import type { RenderQueue } from '../../../core/commands';
import { SpotAnimRenderer } from '../../SpotAnimRenderer';
import { YamaAttackController } from '../YamaAttackController';

function fixture() {
  const renderer = new SpotAnimRenderer();
  const controller = new YamaAttackController();
  for (const spotAnimId of YAMA_ATTACK_PRELOAD_IDS) {
    renderer['meshCache'].set(spotAnimId, {
      static: [],
      frames: [0, 1, 2].map((frame) => [
        {
          kind: 'mesh3d',
          meshId: `${spotAnimId}-${frame}`,
          materialId: 'osrs-npc',
          positions: new Float32Array(9),
          normals: new Float32Array(9),
          modelMatrix: new Float32Array(16),
          depth: 'readwrite',
        },
      ]),
      frameLengths: [30, 30, 30],
      frameStep: -1,
      heightOffset: 0,
    });
  }
  const update = (
    tick: number,
    npcCenter: readonly [number, number, number] = [31.5, 30.5, -2],
    player: [number, number] = [40, 44],
  ) => {
    controller.update(renderer, Math.floor(tick), tick, player, npcCenter, 512, 1024);
    renderer.tick(Math.floor(tick), tick);
    const queue: RenderQueue = { replayPresentationReady: true, commands: [] };
    renderer.render(queue);
    return queue.commands.flatMap((command) =>
      command.kind === 'mesh3d'
        ? [{ id: command.meshId, matrix: Array.from(command.modelMatrix), zIndex: command.zIndex }]
        : [],
    );
  };
  return { renderer, controller, update };
}

function castEvent(tick: number, attackKind: AttackKind = 'magic_fire'): GameEvent {
  return {
    eventId: tick,
    tick,
    type: 'attack_started',
    sourceId: 'yama',
    targetId: 'player',
    style: 'magic',
    attackKind,
  };
}

describe('YamaAttackController', () => {
  it('anchors the cast spotanim to the center it is given, every frame', () => {
    const { controller, update } = fixture();
    controller.consumeEvents([castEvent(10)]);
    update(11);

    const cast = update(12, [31.5, 33.5, -2]).find((mesh) => mesh.zIndex === 46);

    expect(cast?.matrix.slice(12, 15)).toEqual([31.5, 33.5, -2]);
    expect(cast?.matrix[1]).toBeCloseTo(-1 / 128);
    expect(cast?.id).toBe(`${SpotAnimID.VFX_NPC_YAMA_MAGIC_FIRE_SPOTANIM01}-1`);
  });

  it('leaves the player impact where the player is, not where Yama is', () => {
    const { controller, update } = fixture();
    controller.consumeEvents([castEvent(10)]);
    update(10);

    const impact = update(11, [31.5, 30.5, -2], [42, 45]).find((mesh) => mesh.zIndex === 71);

    expect(impact?.matrix.slice(12, 14)).toEqual([42.5, 45.5]);
    expect(impact?.matrix[14]).toBeCloseTo(0);
    expect(impact?.matrix[0]).toBeCloseTo(-1 / 128);
  });

  it('maps each attack kind to its own cast and impact spotanims', () => {
    const { controller, update } = fixture();
    controller.consumeEvents([castEvent(10, 'magic_shadow')]);

    const ids = update(11).map((mesh) => mesh.id);

    expect(ids).toEqual([
      `${SpotAnimID.VFX_NPC_YAMA_MAGIC_SHADOW_SPOTANIM01}-0`,
      `${SpotAnimID.VFX_PLAYER_YAMA_MAGIC_SHADOW_IMPACT01}-1`,
    ]);
  });

  it.each([
    10, 10.999, 11, 13, 13.999, 14,
  ])('keeps impact immediate and cast delayed with exclusive expiry at tick %s', (tick) => {
    const { controller, update } = fixture();
    controller.consumeEvents([castEvent(10)]);

    const meshes = update(tick);

    expect(meshes.some((mesh) => mesh.zIndex === 46)).toBe(tick >= 11 && tick < 14);
    expect(meshes.some((mesh) => mesh.zIndex === 71)).toBe(tick < 13);
  });

  it('retains original phase when an unloaded cast becomes ready at a held destination', () => {
    const { controller, renderer, update } = fixture();
    const id = SpotAnimID.VFX_NPC_YAMA_MAGIC_FIRE_SPOTANIM01;
    const cache = renderer['meshCache'].get(id);
    if (!cache) expect.fail('Expected cast cache');
    renderer['meshCache'].delete(id);
    controller.consumeEvents([castEvent(10)]);
    update(10);
    renderer['meshCache'].set(id, cache);

    const meshes = update(12);

    expect(meshes.find((mesh) => mesh.zIndex === 46)?.id).toBe(`${id}-1`);
  });

  it('clears both pending and active effects without removing another owner', () => {
    const { controller, renderer, update } = fixture();
    controller.consumeEvents([castEvent(10)]);
    update(10);
    renderer.spawn({
      instanceId: 'other',
      spotAnimId: YAMA_ATTACK_PRELOAD_IDS[0],
      transform: { kind: 'static', value: { position: [0, 0, 0] } },
      lifecycle: { kind: 'manual' },
      style: { zIndex: 99 },
    });

    controller.clearActive(renderer);

    expect(update(11).map((mesh) => mesh.zIndex)).toEqual([99]);
  });
});
