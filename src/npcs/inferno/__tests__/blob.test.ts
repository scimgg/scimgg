import { afterEach, describe, expect, it } from 'vitest';
import { setArenaConfig, setDefaultArenaConfig } from '../../../core/constants';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import type { GameEvent } from '../../../core/events/types';
import { CollisionFlag } from '../../../rs/collision/CollisionFlag';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import { createBlob, createSplitBlob, SPLIT_BLOB_OFFSETS, splitBlobSpawns } from '../blob';
import { createInfernoWaveNpc } from '../waveNpcs';
import { createWaveEngine } from './waveFixture';

afterEach(() => {
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

const ATTACK_CLIPS = new Set(['magic', 'range', 'melee']);

function attacksBy(events: readonly GameEvent[], actorId: string) {
  return events
    .filter(isEncounterVisualEvent)
    .flatMap((event) =>
      event.animations
        .filter((animation) => animation.actorId === actorId && ATTACK_CLIPS.has(animation.clipId))
        .map((animation) => ({ tick: event.tick, style: animation.clipId, projectiles: event.projectiles })),
    );
}

/** A blob held in place, so only the player's (teleported) tile decides reach. */
function boundBlob(position: Coordinate = [10, 10]) {
  const blob = createBlob({ id: 'blob', position, spawnTick: 0, targetId: 'player' });
  blob.debuffs = { boundUntilTick: 1000 };
  return blob;
}

/** One OBJECT_PROJECTILE_BLOCKER tile in an otherwise open 64x64 arena. */
function blockLineOfSight(tile: Coordinate) {
  const flags = new Int32Array(64 * 64);
  flags[tile[0] + tile[1] * 64] = CollisionFlag.OBJECT_PROJECTILE_BLOCKER;
  setArenaConfig(
    {
      bounds: null,
      walkableTiles: null,
      collisionMap: {
        sizeX: 64,
        sizeY: 64,
        flags,
        getFlag: (x, y) => flags[x + y * 64],
        hasFlag: (x, y, flag) => (flags[x + y * 64] & flag) !== 0,
        flag: (x, y, flag) => {
          flags[x + y * 64] |= flag;
        },
        unflag: (x, y, flag) => {
          flags[x + y * 64] &= ~flag;
        },
      },
    },
    true,
  );
}

const ticksOf = (attacks: ReturnType<typeof attacksBy>) => attacks.map(({ tick, style }) => [tick, style]);
// Gap 20 from the 3x3 at (10, 10): out of reach.
const FAR: Coordinate = [10, 33];

describe('Jal-Ak read and release', () => {
  it('reads on its first turn with reach and releases 3 ticks later, every 6 ticks while in reach', () => {
    const blob = boundBlob();
    const { advanceTo, events } = createWaveEngine([blob]);
    advanceTo(16);
    // Read 1 / fire 4 / read 7 / fire 10 / read 13 / fire 16; draw 0.5 is magic with no protection.
    expect(ticksOf(attacksBy(events, 'blob'))).toEqual([
      [4, 'magic'],
      [10, 'magic'],
      [16, 'magic'],
    ]);
  });

  it('waits until the player is first in reach, then registers, delays 3 ticks and fires', () => {
    const blob = boundBlob();
    const { player, advanceTo, events } = createWaveEngine([blob], { startPos: FAR });
    advanceTo(19);
    player.position = [10, 20];
    advanceTo(22);
    expect(attacksBy(events, 'blob')).toEqual([]);
    advanceTo(23);
    expect(ticksOf(attacksBy(events, 'blob'))).toEqual([[23, 'magic']]);
  });

  it('reacquires on the first tick with reach after its post-release decision tick', () => {
    const blob = boundBlob();
    const { player, advanceTo, events } = createWaveEngine([blob]);
    advanceTo(4);
    player.position = [...FAR];
    advanceTo(11);
    player.position = [10, 20];
    advanceTo(15);
    expect(ticksOf(attacksBy(events, 'blob'))).toEqual([
      [4, 'magic'],
      [15, 'magic'],
    ]);
  });

  it.each([
    [PrayerType.ProtectMagic, 'range'],
    [PrayerType.ProtectRange, 'magic'],
  ] as const)('locks the answer to %s at the read, whatever the prayer at release', (prayer, style) => {
    const blob = boundBlob();
    const { player, advanceTo, events } = createWaveEngine([blob]);
    player.activePrayer = prayer;
    advanceTo(1);
    player.activePrayer = prayer === PrayerType.ProtectMagic ? PrayerType.ProtectRange : PrayerType.ProtectMagic;
    advanceTo(4);
    expect(ticksOf(attacksBy(events, 'blob'))).toEqual([[4, style]]);
  });

  it('emits the capture-timed projectile for the released style', () => {
    const blob = boundBlob();
    const { player, advanceTo, events } = createWaveEngine([blob]);
    player.activePrayer = PrayerType.ProtectRange;
    advanceTo(4);
    // Center (11, 11) to the player at (10, 20): D = 9.
    expect(attacksBy(events, 'blob')[0]?.projectiles).toMatchObject([
      { spotAnimId: 1380, startDelayCycles: 28, endDelayCycles: 28 + 8 * 9, startHeight: 160, endHeight: 124 },
    ]);
  });

  it('fires through line of sight lost during the windup, then waits for it to return', () => {
    const blob = boundBlob();
    const { player, advanceTo, events } = createWaveEngine([blob]);
    advanceTo(1);
    blockLineOfSight([11, 16]);
    player.position = [11, 20];
    advanceTo(13);
    expect(ticksOf(attacksBy(events, 'blob'))).toEqual([[4, 'magic']]);
  });

  it('drops a release when the player starts its tick 16 tiles away, even if the blob steps to 15', () => {
    const blob = createBlob({ id: 'blob', position: [10, 10], spawnTick: 0, targetId: 'player' });
    const { player, advanceTo, events } = createWaveEngine([blob]);
    advanceTo(3);
    // North edge y 12; 16 tiles beyond it is y 29.
    player.position = [10, 29];
    advanceTo(4);
    expect(blob.position).toEqual([10, 11]);
    expect(attacksBy(events, 'blob')).toEqual([]);
    // Next read at release+3, its shot 3 later.
    advanceTo(10);
    expect(ticksOf(attacksBy(events, 'blob'))).toEqual([[10, 'magic']]);
  });

  it('launches from its footprint at the start of a tick it steps on', () => {
    const blob = createBlob({ id: 'blob', position: [10, 10], spawnTick: 0, targetId: 'player' });
    const { player, advanceTo, events } = createWaveEngine([blob]);
    advanceTo(3);
    // Underneath it at the release: in range of the old footprint, and it steps off.
    player.position = [11, 11];
    advanceTo(4);
    expect(blob.position).not.toEqual([10, 10]);
    expect(attacksBy(events, 'blob')[0]).toMatchObject({
      tick: 4,
      projectiles: [{ sourcePosition: [11.5, 11.5], endDelayCycles: 28 }],
    });
  });

  it.each([
    ['before', 3, true],
    ['after', 5, false],
  ] as const)('is blocked by Protect from Missiles switched on %s the release (tick %i): %s', (_, onTick, blocked) => {
    const blob = boundBlob();
    const { engine, player, advanceTo } = createWaveEngine([blob]);
    // Read Protect from Magic -> ranged released at 4, landing at 7 (D 9: floor(104 / 30) = 3).
    player.activePrayer = PrayerType.ProtectMagic;
    advanceTo(1);
    player.activePrayer = null;
    advanceTo(onTick - 1);
    player.activePrayer = PrayerType.ProtectRange;
    advanceTo(7);
    const [hit] = engine.getDamageHistory();
    expect(hit).toMatchObject({ tick: 7, attackType: 'range', prayedCorrectly: blocked });
    expect(hit?.effectiveDamage === 0).toBe(blocked);
  });

  it.each([
    [3, true],
    [2, false],
  ] as const)('releases a read on its death-animation tick only (killed by a hit landing on %i)', (killTick, fires) => {
    const blob = boundBlob();
    const { engine, advanceTo, events } = createWaveEngine([blob]);
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: blob.id,
      style: 'range',
      attackKind: 'range_arrow',
      launchTick: 0,
      impactTick: killTick,
      rolledDamage: blob.vitals.hp,
      accuracySucceeded: true,
    });
    advanceTo(8);
    // Read at 1, release due at 4; the death sequence starts the tick after the kill.
    expect(blob.deathAnimationTick).toBe(killTick + 1);
    const released = events.filter(isEncounterVisualEvent).filter((event) => event.projectiles.length > 0);
    // Magic (draw 0.5, no prayer), D 9: endtime 28 + 72 = 100 -> lands floor(100 / 30) = 3 ticks later.
    expect(released).toMatchObject(fires ? [{ tick: 4, animations: [], projectiles: [{ spotAnimId: 1380 }] }] : []);
    expect(attacksBy(events, 'blob')).toEqual([]);
    expect(engine.getDamageHistory().filter((hit) => hit.targetId === 'player')).toMatchObject(
      fires ? [{ tick: 7, attackType: 'magic' }] : [],
    );
  });
});

describe('Jal-Ak melee', () => {
  it.each([
    ['north', [11, 13]],
    ['north-east diagonal', [13, 13]],
    ['south-west diagonal', [9, 9]],
  ] as const)('swings at once from %s on a decision tick, then reads 6 later and fires 9 later', (_, tile) => {
    const blob = boundBlob();
    const { engine, random, advanceTo, events } = createWaveEngine([blob], { startPos: [...tile] });
    random.next = () => 0.25;
    advanceTo(1);
    expect(ticksOf(attacksBy(events, 'blob'))).toEqual([[1, 'melee']]);
    expect(engine.getDamageHistory()).toMatchObject([{ tick: 1, attackType: 'melee' }]);
    random.next = () => 0.75;
    advanceTo(10);
    expect(ticksOf(attacksBy(events, 'blob'))).toEqual([
      [1, 'melee'],
      [10, 'magic'],
    ]);
  });

  it.each([
    [0.25, 'range'],
    [0.75, 'magic'],
  ] as const)('never melees through Protect from Melee, which reads as no protection (draw %s -> %s)', (draw, style) => {
    const blob = boundBlob();
    const { player, random, advanceTo, events } = createWaveEngine([blob], { startPos: [11, 13] });
    player.activePrayer = PrayerType.ProtectMelee;
    random.next = () => draw;
    advanceTo(4);
    expect(ticksOf(attacksBy(events, 'blob'))).toEqual([[4, style]]);
  });

  it('keeps its children to cardinal melee', () => {
    const child = createSplitBlob({
      id: 'ket',
      species: 'blob_melee',
      position: [9, 19],
      spawnTick: 0,
      targetId: 'player',
    });
    child.debuffs = { boundUntilTick: 1000 };
    const { advanceTo, events } = createWaveEngine([child]);
    advanceTo(4);
    expect(attacksBy(events, 'ket')).toEqual([]);
  });
});

describe('Jal-Ak split', () => {
  it('births Xil, Ket and Mej in that order on the parent footprint diagonal', () => {
    expect(splitBlobSpawns({ position: [20, 30] })).toEqual([
      { species: 'blob_range', position: [21, 31] },
      { species: 'blob_melee', position: [20, 30] },
      { species: 'blob_mage', position: [22, 32] },
    ]);
    expect(SPLIT_BLOB_OFFSETS.map(({ offset }) => offset)).toEqual([
      [1, 1],
      [0, 0],
      [2, 2],
    ]);
  });

  // P t609 (P:2533-2600): parent SW (31,23); the children are added in Xil, Ket, Mej order, then the parent
  // leaves, clearing its 3x3 of flags. Ket steps in its add tick, and its captured add tile is (30,24).
  it('adds the children before the parent leaves, so they take a first step on the add tick', () => {
    const blob = createBlob({ id: 'blob', position: [31, 23], spawnTick: 0, targetId: 'player' });
    blob.debuffs = { boundFromTick: 0, boundUntilTick: 100_000 };
    const { engine, world, advanceTo } = createWaveEngine([blob], { startPos: [30, 25], spawnSplits: true });
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: blob.id,
      style: 'range',
      attackKind: 'range_arrow',
      launchTick: 0,
      impactTick: 2,
      rolledDamage: blob.vitals.hp,
      accuracySucceeded: true,
    });
    advanceTo(5);

    const children = world.getNpcs().filter((npc) => npc.id.startsWith('blob_'));
    expect(children.map((npc) => [npc.id, npc.processingOrder! > 0])).toEqual([
      ['blob_blob_range', true],
      ['blob_blob_melee', true],
      ['blob_blob_mage', true],
    ]);
    // Ket (melee, reach 1) is born at the parent SW (31,23) and steps to (30,24), next to the player.
    expect(world.getNpc('blob_blob_melee')?.position).toEqual([30, 24]);
    expect(world.getNpc('blob_blob_range')?.position).toEqual([32, 24]);
    expect(world.getNpc('blob_blob_mage')?.position).toEqual([33, 25]);
    // The parent's removal cleared every birth tile: Xil, still on its birth tile, no longer blocks it.
    expect(world.occupancy.isBlocked(32, 24)).toBe(false);
  });

  it('is removed two ticks after its death sequence and requests the split on that tick', () => {
    const blob = createBlob({ id: 'blob', position: [10, 10], spawnTick: 0, targetId: 'player' });
    const { engine, world, removals, advanceTo } = createWaveEngine([blob]);
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: blob.id,
      style: 'range',
      attackKind: 'range_arrow',
      launchTick: 0,
      impactTick: 2,
      rolledDamage: blob.vitals.hp,
      accuracySucceeded: true,
    });
    advanceTo(4);
    expect(blob).toMatchObject({ alive: false, deathAnimationTick: 3 });
    expect(world.getNpc(blob.id)).toBe(blob);
    advanceTo(5);
    expect(world.getNpc(blob.id)).toBeNull();
    expect(removals).toEqual([{ tick: 5, actorId: 'blob', npcTypeId: 7693, splits: splitBlobSpawns(blob) }]);
  });

  it('children act in sync from spawn+3 on a 4-tick cadence with fixed styles', () => {
    const children = [
      createSplitBlob({ id: 'xil', species: 'blob_range', position: [10, 15], spawnTick: 0, targetId: 'player' }),
      createSplitBlob({ id: 'ket', species: 'blob_melee', position: [10, 19], spawnTick: 0, targetId: 'player' }),
      createSplitBlob({ id: 'mej', species: 'blob_mage', position: [11, 15], spawnTick: 0, targetId: 'player' }),
    ];
    const { player, advanceTo, events } = createWaveEngine(children);
    // No prayer read: the children ignore the overhead.
    player.activePrayer = PrayerType.ProtectMagic;
    advanceTo(11);

    expect(attacksBy(events, 'xil').map(({ tick, style }) => [tick, style])).toEqual([
      [3, 'range'],
      [7, 'range'],
      [11, 'range'],
    ]);
    expect(attacksBy(events, 'ket').map(({ tick, style }) => [tick, style])).toEqual([
      [3, 'melee'],
      [7, 'melee'],
      [11, 'melee'],
    ]);
    expect(attacksBy(events, 'mej').map(({ tick, style }) => [tick, style])).toEqual([
      [3, 'magic'],
      [7, 'magic'],
      [11, 'magic'],
    ]);
    expect(attacksBy(events, 'xil')[0]?.projectiles).toMatchObject([
      { spotAnimId: 1379, startDelayCycles: 10, endDelayCycles: 32 + 8 * 5, startHeight: 80 },
    ]);
    expect(attacksBy(events, 'mej')[0]?.projectiles).toMatchObject([
      { spotAnimId: 1381, startDelayCycles: 28, endDelayCycles: 28 + 8 * 5, startHeight: 80 },
    ]);
  });

  it('builds split children through the wave factory', () => {
    const child = createInfernoWaveNpc('blob_melee', {
      id: 'ket',
      position: [3, 4],
      spawnTick: 9,
      targetId: 'player',
      origin: 'split',
    });
    expect(child).toMatchObject({ npcTypeId: 7696, size: 1, vitals: { hp: 15, maxHp: 15 }, spawnTick: 9 });
  });
});
