import { describe, expect, it } from 'vitest';
import { LOBBY_BOSS_NPCS } from '../../../../encounters/lobby/metadata';
import { YAMA_NPC_ID } from '../../../../rs/model/NpcModelLoader';
import { PRIMARY_NPC_ACTOR_ID } from '../../../npc/NpcInstanceManager';
import { applyLobbyBossTransforms, type LobbyNpcInstanceManagerLike } from '../lobbyBossModels';
import { LOBBY_DISPLAY_SIZE } from '../lobbyConstants';

/** Actor id the transform writes under, accounting for the Yama primary-NPC remap. */
function actorIdOf(boss: (typeof LOBBY_BOSS_NPCS)[number]): string {
  return boss.npcTypeId === YAMA_NPC_ID ? PRIMARY_NPC_ACTOR_ID : boss.actorId;
}

function pedestalScale(boss: (typeof LOBBY_BOSS_NPCS)[number], naturalSize: number): number {
  return (1 / 128) * ((boss.displaySize ?? LOBBY_DISPLAY_SIZE) / naturalSize);
}

function pedestalCenter(boss: (typeof LOBBY_BOSS_NPCS)[number]): { x: number; y: number } {
  return { x: boss.position[0] + LOBBY_DISPLAY_SIZE / 2, y: boss.position[1] + LOBBY_DISPLAY_SIZE / 2 };
}

/**
 * A drawn figure, expressed the way real mesh commands are: flat `[x, y, z, ...]`
 * model-space positions. OSRS model space is `-Y = up`, so `bottomY` is the geometry's
 * LOWEST point. `limb` sits high above the base and stands in for the arms/tails that
 * must NOT influence where the statue is planted.
 */
function meshFigure(opts: { baseX: number; baseZ: number; bottomY: number; limbX?: number; limbZ?: number }) {
  const { baseX, baseZ, bottomY, limbX = baseX, limbZ = baseZ } = opts;
  const foot = 60;
  const positions = new Float32Array([
    baseX - foot,
    bottomY,
    baseZ - foot,
    baseX + foot,
    bottomY,
    baseZ + foot,
    limbX,
    bottomY - 700,
    limbZ,
  ]);
  return [{ meshId: 'test-mesh', positions }];
}

function makeManager(
  naturalSizeByType: Record<number, number>,
  meshByActor: Record<string, ReturnType<typeof meshFigure> | null> = {},
): {
  manager: LobbyNpcInstanceManagerLike;
  matrices: Map<string, Float32Array>;
} {
  const matrices = new Map<string, Float32Array>();
  const manager = {
    getNpcTypeSize: (npcTypeId: number) => naturalSizeByType[npcTypeId] ?? 5,
    getTerrainHeights: () => Array.from({ length: 65 }, () => new Int32Array(65)),
    setInstanceModelMatrix: (actorId: string, modelMatrix: Float32Array) => {
      matrices.set(actorId, modelMatrix);
    },
    getInstanceMeshCommands: (actorId: string) => meshByActor[actorId] ?? null,
  } as unknown as LobbyNpcInstanceManagerLike;
  return { manager, matrices };
}

function matrixFor(matrices: Map<string, Float32Array>, boss: (typeof LOBBY_BOSS_NPCS)[number]): Float32Array {
  const matrix = matrices.get(actorIdOf(boss));
  if (!matrix) throw new Error(`No model matrix set for ${actorIdOf(boss)}`);
  return matrix;
}

/** Push a model-space point through the transform's matrix into world space. */
function toWorld(matrix: Float32Array, x: number, y: number, z: number): { x: number; y: number; z: number } {
  return {
    x: matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    y: matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    z: matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  };
}

describe('applyLobbyBossTransforms', () => {
  it('falls back to pivot placement on the pedestal when an instance has no geometry yet', () => {
    const { manager, matrices } = makeManager({});
    applyLobbyBossTransforms(manager, new Map(), new Map());

    for (const boss of LOBBY_BOSS_NPCS) {
      const matrix = matrixFor(matrices, boss);
      expect(matrix[12]).toBeCloseTo(pedestalCenter(boss).x, 4);
      expect(matrix[13]).toBeCloseTo(pedestalCenter(boss).y, 4);
      expect(matrix[14]).toBe(0);
    }
  });

  it('lifts geometry that hangs below the origin plane so it stands on the pedestal', () => {
    const zuk = LOBBY_BOSS_NPCS[0];
    const bottomY = 155;
    const { manager, matrices } = makeManager(
      { [zuk.npcTypeId]: 7 },
      { [actorIdOf(zuk)]: meshFigure({ baseX: 0, baseZ: 0, bottomY }) },
    );
    applyLobbyBossTransforms(manager, new Map(), new Map());

    const matrix = matrixFor(matrices, zuk);
    expect(toWorld(matrix, 0, bottomY, 0).z).toBeCloseTo(0, 6);
    expect(matrix[14]).toBeCloseTo(bottomY * pedestalScale(zuk, 7), 6);
  });

  it('plants the figure by its base, ignoring limbs held far off to one side', () => {
    const zuk = LOBBY_BOSS_NPCS[0];
    const { manager, matrices } = makeManager(
      { [zuk.npcTypeId]: 7 },
      { [actorIdOf(zuk)]: meshFigure({ baseX: 0, baseZ: 0, bottomY: 0, limbX: -350, limbZ: -400 }) },
    );
    applyLobbyBossTransforms(manager, new Map(), new Map());

    const matrix = matrixFor(matrices, zuk);
    expect(matrix[12]).toBeCloseTo(pedestalCenter(zuk).x, 4);
    expect(matrix[13]).toBeCloseTo(pedestalCenter(zuk).y, 4);
  });

  it('centers each boss by its base, rotated through its own facing and scale', () => {
    const naturalSizes: Record<number, number> = {};
    const meshes: Record<string, ReturnType<typeof meshFigure>> = {};
    const bases = [
      { baseX: 0, baseZ: 172 },
      { baseX: -15, baseZ: 57 },
      { baseX: 7, baseZ: 16 },
      { baseX: -22, baseZ: -40 },
    ];
    LOBBY_BOSS_NPCS.forEach((boss, i) => {
      naturalSizes[boss.npcTypeId] = i === 0 ? 7 : 5;
      meshes[actorIdOf(boss)] = meshFigure({ ...bases[i], bottomY: 0, limbX: 300, limbZ: -300 });
    });

    const { manager, matrices } = makeManager(naturalSizes, meshes);
    applyLobbyBossTransforms(manager, new Map(), new Map());

    LOBBY_BOSS_NPCS.forEach((boss, i) => {
      const world = toWorld(matrixFor(matrices, boss), bases[i].baseX, 0, bases[i].baseZ);
      expect(world.x).toBeCloseTo(pedestalCenter(boss).x, 4);
      expect(world.y).toBeCloseTo(pedestalCenter(boss).y, 4);
    });

    const zuk = LOBBY_BOSS_NPCS[0];
    const zukMatrix = matrixFor(matrices, zuk);
    expect(zukMatrix[12]).not.toBeCloseTo(pedestalCenter(zuk).x, 2);
    expect(zukMatrix[13]).not.toBeCloseTo(pedestalCenter(zuk).y, 2);
  });

  it('anchors on the first measurement so an idle animation cannot slide the statue', () => {
    // Re-measuring idle animation frames makes each statue slide.
    const zuk = LOBBY_BOSS_NPCS[0];
    const footprintCache = new Map();
    const mesh = meshFigure({ baseX: 0, baseZ: 172, bottomY: 155 });
    const { manager, matrices } = makeManager({ [zuk.npcTypeId]: 7 }, { [actorIdOf(zuk)]: mesh });

    applyLobbyBossTransforms(manager, new Map(), footprintCache);
    const anchored = Array.from(matrixFor(matrices, zuk));

    mesh[0].positions = meshFigure({ baseX: 34, baseZ: 210, bottomY: 120 })[0].positions;
    applyLobbyBossTransforms(manager, new Map(), footprintCache);

    expect(Array.from(matrixFor(matrices, zuk))).toEqual(anchored);
  });
});
